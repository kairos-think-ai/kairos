const ALL_PLATFORMS = ['claude', 'chatgpt', 'gemini'];

async function init() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });

  // State 1: Not authenticated — show auth view
  if (!status.isAuthenticated) {
    document.getElementById('authView').style.display = 'block';
    document.getElementById('mainView').style.display = 'none';
    document.getElementById('tierSelectView').style.display = 'none';
    document.getElementById('statusDot').className = 'status-dot disconnected';

    document.getElementById('signInBtn').addEventListener('click', async () => {
      await chrome.tabs.create({ url: `${status.gatewayUrl}/login` });
    });
    return;
  }

  // State 2: Authenticated but no tier chosen — show tier selection
  if (!status.privacyTier) {
    document.getElementById('authView').style.display = 'none';
    document.getElementById('mainView').style.display = 'none';
    document.getElementById('tierSelectView').style.display = 'block';
    document.getElementById('statusDot').className = 'status-dot';

    document.getElementById('chooseMirror').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'SET_PRIVACY_TIER', tier: 'mirror' });
      init();
    });

    document.getElementById('chooseAnalyst').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'SET_PRIVACY_TIER', tier: 'analyst' });
      init();
    });
    return;
  }

  // State 3: Authenticated + tier chosen — show main view
  document.getElementById('authView').style.display = 'none';
  document.getElementById('tierSelectView').style.display = 'none';
  document.getElementById('mainView').style.display = 'block';

  // Status dot
  const dot = document.getElementById('statusDot');
  dot.className = `status-dot ${status.isCapturing ? '' : 'paused'}`;

  // Tier badge (compact)
  const tierBadgeValue = document.getElementById('tierBadgeValue');
  if (status.privacyTier === 'mirror') {
    tierBadgeValue.textContent = '\u{1F6E1}\u{FE0F}';
  } else {
    tierBadgeValue.textContent = '\u{1F52C}';
  }

  // Compact stats
  document.getElementById('dailyCount').textContent = status.conversationsCapturedToday;

  const secondLabel = document.getElementById('secondStatLabel');
  const secondValue = document.getElementById('secondStatValue');

  if (status.privacyTier === 'mirror') {
    secondLabel.textContent = 'Local';
    secondValue.textContent = status.totalLocalConversations;
  } else {
    secondLabel.textContent = 'Pending';
    secondValue.textContent = status.pendingSync;
  }

  // Capture toggle
  const toggle = document.getElementById('captureToggle');
  toggle.checked = status.isCapturing;
  toggle.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SET_CAPTURING', value: e.target.checked });
    dot.className = `status-dot ${e.target.checked ? '' : 'paused'}`;
  });

  // Dashboard link
  document.getElementById('dashboardLink').href = status.gatewayUrl;

  // Fetch and render briefing (async — doesn't block popup)
  loadBriefing();
}

/**
 * Load briefing from service worker and render cards.
 * This is the agent's voice — proactive knowledge transfer.
 */
async function loadBriefing() {
  const contentEl = document.getElementById('briefingContent');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_BRIEFING' });

    if (!response?.ok || !response.briefing) {
      renderEmptyBriefing(contentEl);
      return;
    }

    const briefing = response.briefing;
    const cards = [];

    // 1. Resurface ideas (SM-2 due)
    if (briefing.resurfaceIdeas && briefing.resurfaceIdeas.length > 0) {
      for (const idea of briefing.resurfaceIdeas) {
        cards.push(renderCard(
          'resurface',
          '\u{1F504} Revisit',
          truncate(idea.summary, 80),
          idea.timesSurfaced > 0 ? `Surfaced ${idea.timesSurfaced}x before` : null
        ));
      }
    }

    // 2. Prompt lesson
    if (briefing.promptLesson) {
      const lesson = briefing.promptLesson;
      const prefix = lesson.worked ? '\u{2705}' : '\u{26A0}\u{FE0F}';
      cards.push(renderCard(
        'lesson',
        `${prefix} Prompt tip`,
        truncate(lesson.summary, 90),
        lesson.context ? truncate(lesson.context, 60) : null
      ));
    }

    // 3. Active cluster
    if (briefing.activeCluster) {
      const cluster = briefing.activeCluster;
      cards.push(renderCard(
        'cluster',
        '\u{1F3AF} Active thread',
        `"${truncate(cluster.label, 50)}"`,
        `${cluster.ideaCount} ideas \u{00B7} seen ${cluster.recurrenceCount}x`
      ));
    }

    // 4. Coaching insight
    if (briefing.coachingInsight) {
      const insight = briefing.coachingInsight;
      cards.push(renderCard(
        'coaching',
        '\u{1F9ED} Coaching',
        truncate(insight.observation, 90),
        insight.experiment ? `Try: ${truncate(insight.experiment, 60)}` : null
      ));
    }

    if (cards.length === 0) {
      renderEmptyBriefing(contentEl);
    } else {
      contentEl.innerHTML = cards.join('');
    }
  } catch (err) {
    console.warn('[Kairos Popup] Briefing load failed:', err);
    renderEmptyBriefing(contentEl);
  }
}

function renderCard(type, title, text, meta) {
  return `
    <div class="briefing-card ${type}">
      <div class="briefing-card-title">${escapeHtml(title)}</div>
      <div class="briefing-card-text">${escapeHtml(text)}</div>
      ${meta ? `<div class="briefing-card-meta">${escapeHtml(meta)}</div>` : ''}
    </div>
  `;
}

function renderEmptyBriefing(el) {
  el.innerHTML = `
    <div class="briefing-empty">
      Start a conversation &mdash;<br>I'll have insights for you next time.
    </div>
  `;
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

init();
