/**
 * Kairos Local Storage — IndexedDB Wrapper
 *
 * The "DNA Layer" (Layer 1 of the Thinking Vault).
 * All captured conversations are stored here FIRST, always.
 * Cloud sync is opt-in (Tier 2 "The Analyst" only).
 *
 * Design decisions:
 * - No external library — raw IndexedDB API keeps bundle small
 * - Messages stored inline in conversation objects (simpler for MVP)
 * - Works in service workers (IndexedDB is available there)
 * - Audit log is append-only (trust signal)
 */

import type { ConversationPayload, CapturedMessage, Platform } from '../types';

// ============================================================
// TYPES
// ============================================================

export type SyncStatus = 'local' | 'pending' | 'synced' | 'failed';

export interface StoredConversation {
  /** Primary key: "${platform}:${platformConversationId}" */
  id: string;
  platform: Platform;
  platformConversationId: string;
  title: string | null;
  url: string;
  messageCount: number;
  capturedAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  /** Sync tracking */
  syncStatus: SyncStatus;
  syncedAt: string | null;
  /** Messages stored inline for simplicity */
  messages: CapturedMessage[];
}

export interface AuditEntry {
  /** Auto-incremented key */
  id?: number;
  timestamp: string;
  action: 'capture' | 'sync' | 'delete' | 'tier_change';
  conversationId?: string;
  destination: 'local' | 'cloud';
  details?: string;
}

export interface VaultStats {
  total: number;
  synced: number;
  local: number;
  pending: number;
  failed: number;
  todayCount: number;
}

// ============================================================
// DATABASE
// ============================================================

const DB_NAME = 'kairos-vault';
const DB_VERSION = 1;

const STORE_CONVERSATIONS = 'conversations';
const STORE_AUDIT = 'auditLog';

export class KairosDB {
  private db: IDBDatabase | null = null;
  private openPromise: Promise<void> | null = null;

  /**
   * Open the database (idempotent — safe to call multiple times).
   */
  async open(): Promise<void> {
    if (this.db) return;
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Conversations store (DNA Layer)
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          const convStore = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
          convStore.createIndex('platform', 'platform', { unique: false });
          convStore.createIndex('capturedAt', 'capturedAt', { unique: false });
          convStore.createIndex('syncStatus', 'syncStatus', { unique: false });
          convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Audit log (append-only)
        if (!db.objectStoreNames.contains(STORE_AUDIT)) {
          const auditStore = db.createObjectStore(STORE_AUDIT, {
            keyPath: 'id',
            autoIncrement: true,
          });
          auditStore.createIndex('timestamp', 'timestamp', { unique: false });
          auditStore.createIndex('action', 'action', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;

        // Handle connection loss (e.g., browser clears storage)
        this.db.onclose = () => {
          this.db = null;
          this.openPromise = null;
        };

        resolve();
      };

      request.onerror = (event) => {
        this.openPromise = null;
        reject(new Error(`Failed to open IndexedDB: ${(event.target as IDBOpenDBRequest).error}`));
      };
    });

    return this.openPromise;
  }

  /**
   * Ensure db is open before any operation.
   */
  private async ensureOpen(): Promise<IDBDatabase> {
    await this.open();
    if (!this.db) throw new Error('KairosDB: database not available');
    return this.db;
  }

  // ============================================================
  // CONVERSATION OPERATIONS
  // ============================================================

  /**
   * Save a conversation (insert or update).
   * Deduplicates by platform:platformConversationId.
   * Only updates if the new version has more messages.
   */
  async saveConversation(
    payload: ConversationPayload,
    syncStatus: SyncStatus = 'local'
  ): Promise<StoredConversation> {
    const db = await this.ensureOpen();
    const id = `${payload.platform}:${payload.platformConversationId}`;
    const now = new Date().toISOString();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = tx.objectStore(STORE_CONVERSATIONS);

      // Check for existing entry (dedup)
      const getReq = store.get(id);

      getReq.onsuccess = () => {
        const existing: StoredConversation | undefined = getReq.result;

        // Only update if we have more or equal messages
        if (existing && existing.messages.length >= payload.messages.length) {
          resolve(existing);
          return;
        }

        const stored: StoredConversation = {
          id,
          platform: payload.platform,
          platformConversationId: payload.platformConversationId,
          title: payload.title,
          url: payload.url,
          messageCount: payload.messages.length,
          capturedAt: existing?.capturedAt || payload.capturedAt || now,
          updatedAt: now,
          metadata: payload.metadata,
          syncStatus: existing?.syncStatus === 'synced' ? 'synced' : syncStatus,
          syncedAt: existing?.syncedAt || null,
          messages: payload.messages,
        };

        const putReq = store.put(stored);
        putReq.onsuccess = () => resolve(stored);
        putReq.onerror = () => reject(new Error(`Failed to save conversation: ${putReq.error}`));
      };

      getReq.onerror = () => reject(new Error(`Failed to read conversation: ${getReq.error}`));
    });
  }

  /**
   * Get a single conversation by ID.
   */
  async getConversation(id: string): Promise<StoredConversation | undefined> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const req = store.get(id);

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`Failed to get conversation: ${req.error}`));
    });
  }

  /**
   * List conversations with optional filters.
   */
  async listConversations(opts?: {
    platform?: Platform;
    limit?: number;
    syncStatus?: SyncStatus;
  }): Promise<StoredConversation[]> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = tx.objectStore(STORE_CONVERSATIONS);

      let request: IDBRequest;

      if (opts?.platform) {
        const index = store.index('platform');
        request = index.getAll(opts.platform);
      } else if (opts?.syncStatus) {
        const index = store.index('syncStatus');
        request = index.getAll(opts.syncStatus);
      } else {
        request = store.getAll();
      }

      request.onsuccess = () => {
        let results: StoredConversation[] = request.result;

        // Apply additional filters
        if (opts?.platform && opts?.syncStatus) {
          results = results.filter(c => c.syncStatus === opts.syncStatus);
        }

        // Sort by capturedAt descending (most recent first)
        results.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

        // Apply limit
        if (opts?.limit && opts.limit > 0) {
          results = results.slice(0, opts.limit);
        }

        resolve(results);
      };

      request.onerror = () => reject(new Error(`Failed to list conversations: ${request.error}`));
    });
  }

  /**
   * Delete a single conversation.
   */
  async deleteConversation(id: string): Promise<void> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const req = store.delete(id);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to delete conversation: ${req.error}`));
    });
  }

  /**
   * Delete all conversations.
   */
  async deleteAllConversations(): Promise<void> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const req = store.clear();

      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to clear conversations: ${req.error}`));
    });
  }

  // ============================================================
  // SYNC OPERATIONS
  // ============================================================

  /**
   * Get all conversations that need to be synced (status: 'pending' or 'failed').
   */
  async getPendingSyncConversations(): Promise<StoredConversation[]> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const results: StoredConversation[] = [];

      const req = store.openCursor();

      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const conv: StoredConversation = cursor.value;
          if (conv.syncStatus === 'pending' || conv.syncStatus === 'failed') {
            results.push(conv);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      req.onerror = () => reject(new Error(`Failed to query pending conversations: ${req.error}`));
    });
  }

  /**
   * Mark conversations as synced.
   */
  async markSynced(ids: string[]): Promise<void> {
    const db = await this.ensureOpen();
    const now = new Date().toISOString();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      let completed = 0;

      for (const id of ids) {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const conv: StoredConversation = getReq.result;
          if (conv) {
            conv.syncStatus = 'synced';
            conv.syncedAt = now;
            store.put(conv);
          }
          completed++;
          if (completed === ids.length) resolve();
        };
        getReq.onerror = () => {
          completed++;
          if (completed === ids.length) resolve();
        };
      }

      if (ids.length === 0) resolve();
    });
  }

  /**
   * Mark conversations as sync failed.
   */
  async markSyncFailed(ids: string[]): Promise<void> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      let completed = 0;

      for (const id of ids) {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const conv: StoredConversation = getReq.result;
          if (conv) {
            conv.syncStatus = 'failed';
            store.put(conv);
          }
          completed++;
          if (completed === ids.length) resolve();
        };
        getReq.onerror = () => {
          completed++;
          if (completed === ids.length) resolve();
        };
      }

      if (ids.length === 0) resolve();
    });
  }

  /**
   * Update all 'local' conversations to 'pending' (when user switches to Analyst tier).
   */
  async markAllLocalAsPending(): Promise<number> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const index = store.index('syncStatus');
      const req = index.openCursor(IDBKeyRange.only('local'));
      let count = 0;

      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const conv: StoredConversation = cursor.value;
          conv.syncStatus = 'pending';
          cursor.update(conv);
          count++;
          cursor.continue();
        } else {
          resolve(count);
        }
      };

      req.onerror = () => reject(new Error(`Failed to mark local as pending: ${req.error}`));
    });
  }

  // ============================================================
  // STATS
  // ============================================================

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<VaultStats> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const store = tx.objectStore(STORE_CONVERSATIONS);
      const req = store.getAll();

      req.onsuccess = () => {
        const all: StoredConversation[] = req.result;
        const today = new Date().toISOString().slice(0, 10);

        const stats: VaultStats = {
          total: all.length,
          synced: all.filter(c => c.syncStatus === 'synced').length,
          local: all.filter(c => c.syncStatus === 'local').length,
          pending: all.filter(c => c.syncStatus === 'pending').length,
          failed: all.filter(c => c.syncStatus === 'failed').length,
          todayCount: all.filter(c => c.capturedAt.startsWith(today)).length,
        };

        resolve(stats);
      };

      req.onerror = () => reject(new Error(`Failed to get stats: ${req.error}`));
    });
  }

  // ============================================================
  // AUDIT LOG
  // ============================================================

  /**
   * Log an audit entry (append-only).
   */
  async logAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIT, 'readwrite');
      const store = tx.objectStore(STORE_AUDIT);

      const fullEntry: AuditEntry = {
        ...entry,
        timestamp: new Date().toISOString(),
      };

      const req = store.add(fullEntry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to log audit entry: ${req.error}`));
    });
  }

  /**
   * Get audit log entries (most recent first).
   */
  async getAuditLog(limit: number = 100): Promise<AuditEntry[]> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIT, 'readonly');
      const store = tx.objectStore(STORE_AUDIT);
      const req = store.getAll();

      req.onsuccess = () => {
        let results: AuditEntry[] = req.result;
        // Sort by timestamp descending
        results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        results = results.slice(0, limit);
        resolve(results);
      };

      req.onerror = () => reject(new Error(`Failed to get audit log: ${req.error}`));
    });
  }

  /**
   * Clear the audit log.
   */
  async clearAuditLog(): Promise<void> {
    const db = await this.ensureOpen();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIT, 'readwrite');
      const store = tx.objectStore(STORE_AUDIT);
      const req = store.clear();

      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to clear audit log: ${req.error}`));
    });
  }

  // ============================================================
  // DATA EXPORT
  // ============================================================

  /**
   * Export all data as a plain object (for JSON download).
   */
  async exportAll(): Promise<{
    conversations: StoredConversation[];
    auditLog: AuditEntry[];
    exportedAt: string;
  }> {
    const [conversations, auditLog] = await Promise.all([
      this.listConversations(),
      this.getAuditLog(10000),
    ]);

    return {
      conversations,
      auditLog,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.openPromise = null;
    }
  }
}

// Singleton instance for use across the extension
export const kairosDB = new KairosDB();
