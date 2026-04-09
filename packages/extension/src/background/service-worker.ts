import { ConversationPayload, IngestResponse, PrivacyTier } from '../types';
import { kairosDB } from '../storage/kairos-db';

/**
 * Kairos Service Worker — Local-First Signal Router
 *
 * Architecture (aligned with vision):
 *   Capture → IndexedDB (ALWAYS) → Cloud sync (Analyst tier only)
 *
 * All conversations are stored locally in IndexedDB first.
 * Cloud sync only happens if the user has opted into "The Analyst" tier.
 * "The Mirror" tier keeps everything on-device.
 *
 * Also handles:
 * - Privacy tier management (Mirror vs Analyst)
 * - Authentication state
 * - Periodic sync (Analyst tier only)
 * - Extension badge updates
 * - L1 behavioral metadata logging (both tiers)
 * - Data export and deletion
 */

const GATEWAY_URL_KEY = 'gatewayUrl';
const AUTH_TOKEN_KEY = 'authToken';
const AUTH_EXPIRES_KEY = 'authExpiresAt';
const PRIVACY_TIER_KEY = 'privacyTier';
const DEFAULT_GATEWAY = 'http://localhost:3000';
const SYNC_ALARM_NAME = 'kairos-sync';
const SYNC_INTERVAL_MINUTES = 5;
const BEHAVIORAL_KEY = 'behavioralLog';
const BRIEFING_CACHE_KEY = 'briefingCache';
const BRIEFING_CACHE_TIME_KEY = 'briefingCacheTime';
const BRIEFING_CACHE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

// Initialize IndexedDB on service worker startup
kairosDB.open().catch(err => console.error('[Kairos] Failed to open IndexedDB:', err));

// ============================================================
// AUTH TOKEN HELPERS
// ============================================================

/**
 * Check if the stored auth token is expired or about to expire.
 * Returns true if the token is still valid.
 */
async function isTokenValid(): Promise<boolean> {
  const config = await chrome.storage.local.get([AUTH_TOKEN_KEY, AUTH_EXPIRES_KEY]);
  const token = config[AUTH_TOKEN_KEY];
  const expiresAt = config[AUTH_EXPIRES_KEY];

  if (!token) return false;
  if (!expiresAt) return true; // No expiry info — assume valid (legacy tokens)

  const expiresMs = typeof expiresAt === 'number'
    ? expiresAt * 1000 // Unix timestamp in seconds → ms
    : new Date(expiresAt).getTime();

  return Date.now() < expiresMs - TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Attempt to refresh the auth token by fetching from the gateway.
 * Returns true if refresh succeeded.
 */
async function refreshAuthToken(): Promise<boolean> {
  const config = await chrome.storage.local.get([GATEWAY_URL_KEY]);
  const gatewayUrl = config[GATEWAY_URL_KEY] || DEFAULT_GATEWAY;

  try {
    const response = await fetch(`${gatewayUrl}/api/extension-token`, {
      credentials: 'include',
    });

    if (!response.ok) {
      console.warn('[Kairos] Token refresh failed:', response.status);
      return false;
    }

    const data = await response.json();
    if (data.access_token) {
      await chrome.storage.local.set({
        [AUTH_TOKEN_KEY]: data.access_token,
        [AUTH_EXPIRES_KEY]: data.expires_at,
      });
      console.log('[Kairos] Auth token refreshed successfully');
      return true;
    }

    return false;
  } catch (error) {
    console.warn('[Kairos] Token refresh error:', error);
    return false;
  }
}

/**
 * Get a valid auth token, attempting refresh if expired.
 * Returns null if no valid token is available.
 */
async function getValidAuthToken(): Promise<string | null> {
  if (await isTokenValid()) {
    const config = await chrome.storage.local.get([AUTH_TOKEN_KEY]);
    return config[AUTH_TOKEN_KEY] || null;
  }

  // Token expired — attempt refresh
  console.log('[Kairos] Auth token expired, attempting refresh...');
  const refreshed = await refreshAuthToken();
  if (refreshed) {
    const config = await chrome.storage.local.get([AUTH_TOKEN_KEY]);
    return config[AUTH_TOKEN_KEY] || null;
  }

  console.warn('[Kairos] Auth token expired and refresh failed — user needs to re-authenticate');
  return null;
}

// ============================================================
// PRIVACY TIER HELPERS
// ============================================================

async function getPrivacyTier(): Promise<PrivacyTier | null> {
  const result = await chrome.storage.local.get(PRIVACY_TIER_KEY);
  return result[PRIVACY_TIER_KEY] || null;
}

async function setPrivacyTier(tier: PrivacyTier): Promise<void> {
  const oldTier = await getPrivacyTier();
  await chrome.storage.local.set({ [PRIVACY_TIER_KEY]: tier });

  // Log the tier change
  await kairosDB.logAudit({
    action: 'tier_change',
    destination: tier === 'analyst' ? 'cloud' : 'local',
    details: `Changed from ${oldTier || 'none'} to ${tier}`,
  });

  // If switching TO analyst, mark all local conversations as pending sync
  if (tier === 'analyst' && oldTier !== 'analyst') {
    const count = await kairosDB.markAllLocalAsPending();
    if (count > 0) {
      console.log(`[Kairos] Marked ${count} local conversations as pending sync`);
      // Trigger sync immediately
      syncToGateway();
    }
  }
}

// ============================================================
// L1 BEHAVIORAL METADATA LOGGING (both tiers — no content)
// ============================================================

interface BehavioralEntry {
  timestamp: string;
  platform: string;
  messageCount: number;
  hourOfDay: number;
  dayOfWeek: number;
}

async function logBehavioralMetadata(payload: ConversationPayload): Promise<void> {
  const now = new Date();
  const entry: BehavioralEntry = {
    timestamp: now.toISOString(),
    platform: payload.platform,
    messageCount: payload.messages.length,
    hourOfDay: now.getHours(),
    dayOfWeek: now.getDay(),
  };

  const result = await chrome.storage.local.get(BEHAVIORAL_KEY);
  const log: BehavioralEntry[] = result[BEHAVIORAL_KEY] || [];

  // Keep last 1000 entries to avoid storage bloat
  if (log.length >= 1000) {
    log.splice(0, log.length - 999);
  }
  log.push(entry);

  await chrome.storage.local.set({ [BEHAVIORAL_KEY]: log });
}

// ============================================================
// PRE-SESSION BRIEFING — THE AGENT'S VOICE
// ============================================================

/**
 * Fetch a fresh briefing from the dashboard API and cache it locally.
 * Returns the briefing data or null if unavailable.
 */
async function fetchBriefing(): Promise<any | null> {
  const authToken = await getValidAuthToken();
  if (!authToken) return null;

  const config = await chrome.storage.local.get([GATEWAY_URL_KEY]);
  const gatewayUrl = config[GATEWAY_URL_KEY] || DEFAULT_GATEWAY;

  try {
    const response = await fetch(`${gatewayUrl}/api/extension/briefing`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });

    if (!response.ok) {
      console.warn('[Kairos] Briefing fetch failed:', response.status);
      return null;
    }

    const data = await response.json();
    const briefing = data.briefing || null;

    // Cache the briefing
    if (briefing) {
      await chrome.storage.local.set({
        [BRIEFING_CACHE_KEY]: briefing,
        [BRIEFING_CACHE_TIME_KEY]: Date.now(),
      });
    }

    return briefing;
  } catch (error) {
    console.warn('[Kairos] Briefing fetch error:', error);
    return null;
  }
}

/**
 * Get the cached briefing, or fetch a fresh one if cache is stale.
 */
async function getBriefing(): Promise<any | null> {
  const cached = await chrome.storage.local.get([BRIEFING_CACHE_KEY, BRIEFING_CACHE_TIME_KEY]);
  const cacheTime = cached[BRIEFING_CACHE_TIME_KEY] || 0;
  const isFresh = (Date.now() - cacheTime) < BRIEFING_CACHE_MAX_AGE_MS;

  if (isFresh && cached[BRIEFING_CACHE_KEY]) {
    return cached[BRIEFING_CACHE_KEY];
  }

  // Cache is stale — fetch fresh briefing
  return fetchBriefing();
}

// ============================================================
// MESSAGE HANDLING (from content scripts & popup)
// ============================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'CONVERSATION_UPDATE':
      handleConversationUpdate(message.payload as ConversationPayload)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ error: String(err) }));
      return true;

    case 'GET_STATUS':
      getStatus().then(sendResponse);
      return true;

    case 'SET_CAPTURING':
      chrome.storage.local.set({ isCapturing: message.value });
      sendResponse({ ok: true });
      break;

    case 'SET_GATEWAY_URL':
      chrome.storage.local.set({ [GATEWAY_URL_KEY]: message.url });
      sendResponse({ ok: true });
      break;

    case 'SET_PRIVACY_TIER':
      setPrivacyTier(message.tier as PrivacyTier)
        .then(() => {
          updateBadge();
          sendResponse({ ok: true });
        })
        .catch(err => sendResponse({ error: String(err) }));
      return true;

    case 'SIGN_IN':
      chrome.storage.local.set({
        [AUTH_TOKEN_KEY]: message.token,
        ...(message.expires_at ? { [AUTH_EXPIRES_KEY]: message.expires_at } : {}),
      });
      updateBadge();
      sendResponse({ ok: true });
      break;

    case 'SIGN_OUT':
      chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_EXPIRES_KEY]);
      updateBadge();
      sendResponse({ ok: true });
      break;

    case 'GET_LOCAL_DATA':
      getLocalData(message.limit)
        .then(sendResponse)
        .catch(err => sendResponse({ error: String(err) }));
      return true;

    case 'DELETE_LOCAL_DATA':
      deleteLocalData()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ error: String(err) }));
      return true;

    case 'EXPORT_DATA':
      kairosDB.exportAll()
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({ error: String(err) }));
      return true;

    case 'GET_BRIEFING':
      getBriefing()
        .then(briefing => sendResponse({ ok: true, briefing }))
        .catch(err => sendResponse({ ok: false, briefing: null, error: String(err) }));
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return false;
});

// ============================================================
// CONVERSATION HANDLING — LOCAL-FIRST
// ============================================================

async function handleConversationUpdate(payload: ConversationPayload): Promise<void> {
  const tier = await getPrivacyTier();

  // Determine sync status based on tier
  const syncStatus = tier === 'analyst' ? 'pending' as const : 'local' as const;

  // Store in IndexedDB (ALWAYS — both tiers)
  const stored = await kairosDB.saveConversation(payload, syncStatus);

  // Log audit entry
  await kairosDB.logAudit({
    action: 'capture',
    conversationId: stored.id,
    destination: 'local',
    details: `${payload.platform} — ${payload.messages.length} messages`,
  });

  // L1: Log behavioral metadata (no content, just structure — both tiers)
  await logBehavioralMetadata(payload);

  updateBadge();
}

// ============================================================
// BULK IMPORT — from dashboard /import page
// ============================================================

async function handleBulkImport(
  payloads: ConversationPayload[]
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const tier = await getPrivacyTier();
  const syncStatus = tier === 'analyst' ? 'pending' as const : 'local' as const;

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const payload of payloads) {
    try {
      const stored = await kairosDB.saveConversation(payload, syncStatus);

      // Log audit entry
      await kairosDB.logAudit({
        action: 'capture',
        conversationId: stored.id,
        destination: 'local',
        details: `import — ${payload.platform} — ${payload.messages.length} messages`,
      });

      // L1: behavioral metadata (no content)
      await logBehavioralMetadata(payload);

      imported++;
    } catch (err) {
      errors.push(`${payload.platformConversationId}: ${String(err)}`);
      skipped++;
    }
  }

  updateBadge();

  // If Analyst tier, trigger sync after all imports
  if (tier === 'analyst' && imported > 0) {
    syncToGateway();
  }

  return { imported, skipped, errors };
}

// ============================================================
// GATEWAY SYNC (Analyst tier only)
// ============================================================

async function syncToGateway(): Promise<void> {
  // Only sync if user is on Analyst tier
  const tier = await getPrivacyTier();
  if (tier !== 'analyst') return;

  // Get conversations that need syncing from IndexedDB
  const toSync = await kairosDB.getPendingSyncConversations();
  if (toSync.length === 0) return;

  const config = await chrome.storage.local.get([GATEWAY_URL_KEY]);
  const gatewayUrl = config[GATEWAY_URL_KEY] || DEFAULT_GATEWAY;

  const authToken = await getValidAuthToken();
  if (!authToken) {
    console.log('[Kairos] Not authenticated or token expired, skipping sync');
    return;
  }

  // Convert StoredConversation back to ConversationPayload for the API
  const payloads: ConversationPayload[] = toSync.map(conv => ({
    platform: conv.platform,
    platformConversationId: conv.platformConversationId,
    title: conv.title,
    url: conv.url,
    messages: conv.messages,
    metadata: conv.metadata,
    capturedAt: conv.capturedAt,
  }));

  const ids = toSync.map(c => c.id);

  try {
    const response = await fetch(`${gatewayUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ conversations: payloads }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Token rejected by server — clear it so we don't keep retrying
        console.warn('[Kairos] Sync got 401 — clearing expired token');
        await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_EXPIRES_KEY]);
        updateBadge();
        return;
      }
      throw new Error(`Gateway returned ${response.status}`);
    }

    const result: IngestResponse = await response.json();
    console.log(`[Kairos] Synced ${result.ingested} conversations to cloud`);

    // Mark as synced in IndexedDB
    await kairosDB.markSynced(ids);

    // Log audit entries for each synced conversation
    for (const id of ids) {
      await kairosDB.logAudit({
        action: 'sync',
        conversationId: id,
        destination: 'cloud',
      });
    }

    updateBadge();

  } catch (error) {
    console.warn('[Kairos] Sync failed, marking as failed:', error);
    await kairosDB.markSyncFailed(ids);
  }
}

// ============================================================
// LOCAL DATA OPERATIONS
// ============================================================

async function getLocalData(limit?: number) {
  const [conversations, stats, auditLog] = await Promise.all([
    kairosDB.listConversations({ limit: limit || 50 }),
    kairosDB.getStats(),
    kairosDB.getAuditLog(50),
  ]);

  return {
    conversations: conversations.map(c => ({
      id: c.id,
      platform: c.platform,
      title: c.title,
      messageCount: c.messageCount,
      capturedAt: c.capturedAt,
      syncStatus: c.syncStatus,
      syncedAt: c.syncedAt,
    })),
    stats,
    auditLog,
  };
}

async function deleteLocalData(): Promise<void> {
  await kairosDB.logAudit({
    action: 'delete',
    destination: 'local',
    details: 'User deleted all local data',
  });

  await kairosDB.deleteAllConversations();
  // Note: audit log is preserved (append-only)
  updateBadge();
}

// ============================================================
// PERIODIC SYNC (Alarm-based — Analyst tier only)
// ============================================================

chrome.alarms.create(SYNC_ALARM_NAME, {
  periodInMinutes: SYNC_INTERVAL_MINUTES,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    syncToGateway();
    // Also pre-fetch briefing so it's ready when user opens popup
    fetchBriefing().catch(() => { /* silent — briefing is best-effort */ });
  }
});

// Also attempt sync when the service worker wakes up
syncToGateway();

// ============================================================
// STATUS & BADGE
// ============================================================

async function getStatus() {
  const config = await chrome.storage.local.get([
    'isCapturing',
    'platformsEnabled',
    AUTH_TOKEN_KEY,
    AUTH_EXPIRES_KEY,
    GATEWAY_URL_KEY,
    PRIVACY_TIER_KEY,
  ]);

  const stats = await kairosDB.getStats();
  const tier: PrivacyTier | null = config[PRIVACY_TIER_KEY] || null;
  const tokenValid = await isTokenValid();

  return {
    isCapturing: config.isCapturing !== false,
    platformsEnabled: config.platformsEnabled || ['claude', 'chatgpt', 'gemini'],
    isAuthenticated: !!config[AUTH_TOKEN_KEY],
    tokenExpired: !!config[AUTH_TOKEN_KEY] && !tokenValid,
    gatewayUrl: config[GATEWAY_URL_KEY] || DEFAULT_GATEWAY,
    privacyTier: tier,
    // Stats from IndexedDB
    totalLocalConversations: stats.total,
    conversationsCapturedToday: stats.todayCount,
    pendingSync: stats.pending + stats.failed,
    syncedCount: stats.synced,
  };
}

async function updateBadge(): Promise<void> {
  try {
    const stats = await kairosDB.getStats();
    const tier = await getPrivacyTier();

    if (tier === 'analyst' && (stats.pending + stats.failed) > 0) {
      // Analyst tier: show pending sync count
      chrome.action.setBadgeText({ text: String(stats.pending + stats.failed) });
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    } else if (stats.todayCount > 0) {
      // Mirror tier or nothing pending: show today's capture count
      chrome.action.setBadgeText({ text: String(stats.todayCount) });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    // IndexedDB might not be ready yet
    chrome.action.setBadgeText({ text: '' });
  }
}

// ============================================================
// EXTERNAL MESSAGING (from dashboard web page via externally_connectable)
// ============================================================

chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    // Validate sender origin — only accept from our dashboard
    const senderOrigin = sender.url ? new URL(sender.url).origin : '';
    const isAllowed = senderOrigin.startsWith('http://localhost') ||
                      senderOrigin.includes('.vercel.app') ||
                      senderOrigin.includes('.kairos.com');

    if (!isAllowed) {
      console.warn('[Kairos] Rejected external message from:', senderOrigin);
      sendResponse({ success: false, error: 'Unauthorized origin' });
      return;
    }

    if (message.type === 'AUTH_TOKEN') {
      const { access_token, expires_at } = message;
      if (access_token) {
        const storageUpdate: Record<string, unknown> = { [AUTH_TOKEN_KEY]: access_token };
        if (expires_at) storageUpdate[AUTH_EXPIRES_KEY] = expires_at;
        chrome.storage.local.set(storageUpdate, () => {
          console.log('[Kairos] Auth token received from dashboard (expires:', expires_at || 'unknown', ')');
          updateBadge();
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, error: 'Missing access_token' });
      }
      return true;
    }

    if (message.type === 'SIGN_OUT') {
      chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_EXPIRES_KEY], () => {
        console.log('[Kairos] Signed out via dashboard');
        updateBadge();
        sendResponse({ success: true });
      });
      return true;
    }

    if (message.type === 'GET_PRIVACY_TIER') {
      getPrivacyTier().then(tier => {
        sendResponse({ success: true, tier });
      });
      return true;
    }

    if (message.type === 'SET_GATEWAY_URL') {
      const { url } = message;
      if (url) {
        chrome.storage.local.set({ [GATEWAY_URL_KEY]: url }, () => {
          console.log('[Kairos] Gateway URL set from dashboard:', url);
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, error: 'Missing url' });
      }
      return true;
    }

    if (message.type === 'IMPORT_CONVERSATIONS') {
      handleBulkImport(message.conversations)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(err => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    sendResponse({ success: false, error: 'Unknown message type' });
  }
);

// ============================================================
// INSTALLATION
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Kairos] Extension installed — local-first storage ready');
    chrome.storage.local.set({
      isCapturing: true,
      platformsEnabled: ['claude', 'chatgpt', 'gemini'],
      // privacyTier is intentionally NOT set here
      // — forces tier selection on first popup open
    });

    // Initialize IndexedDB
    kairosDB.open().then(() => {
      console.log('[Kairos] IndexedDB vault initialized');
    });
  }
});
