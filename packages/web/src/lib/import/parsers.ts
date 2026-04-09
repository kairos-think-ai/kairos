/**
 * Kairos Import Parsers
 *
 * Converts platform-specific export files into ConversationPayload[].
 * All parsing is client-side — no data leaves the browser.
 */

// ── Types (mirrored from extension to avoid cross-package deps) ──────────

export type Platform = 'claude' | 'chatgpt' | 'gemini' | 'openclaw' | 'other';

export interface CapturedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  sequence: number;
}

export interface ConversationPayload {
  platform: Platform;
  platformConversationId: string;
  title: string | null;
  url: string;
  messages: CapturedMessage[];
  metadata?: Record<string, unknown>;
  capturedAt: string;
}

export type ImportFormat = 'claude-export' | 'chatgpt-export' | 'claude-code-jsonl' | 'openclaw-workspace' | 'unknown';

export interface ParseResult {
  conversations: ConversationPayload[];
  warnings: string[];
  format: ImportFormat;
}

// ── AI Adaptive Parser Types ─────────────────────────────────────────

export interface SchemaMapping {
  platform: Platform;
  formatName: string;
  conversationsPath: string;      // e.g. "root" (if top-level array) or "chats"
  fields: {
    id: string;                   // e.g. "uuid" or "id"
    title: string;                // e.g. "name" or "title"
    createdAt: string;            // e.g. "created_at" or "create_time"
    url?: string;                 // e.g. "url" (if exists)
  };
  messageFields: {
    path: string;                 // e.g. "chat_messages" or "messages"
    role: string;                 // e.g. "sender" or "role" or "author.role"
    roleMap: Record<string, 'user' | 'assistant' | 'system'>;
    content: string;              // e.g. "text" or "content"
    contentArray?: {              // if content is in typed blocks
      path: string;               // e.g. "content"
      typeField: string;          // e.g. "type"
      textField: string;          // e.g. "text"
      includeTypes: string[];     // e.g. ["text"] — skip "thinking"
    };
    timestamp?: string;           // e.g. "created_at"
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Simple deterministic hash for generating IDs from content */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36).padStart(8, '0');
}

function unixToISO(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toISOString();
}

function titleCase(str: string): string {
  return str
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ── Structural Skeleton Extraction (privacy-safe) ─────────────────────

/**
 * Extract a privacy-safe structural skeleton from file content.
 * Keeps ALL field names, nesting, types, and short values (enums, timestamps).
 * Replaces long string content with "[STRING, N chars]".
 */
export function extractSkeleton(content: string, maxItems = 2): string {
  try {
    const data = JSON.parse(content);

    if (Array.isArray(data)) {
      const sample = data.slice(0, maxItems).map(item => skeletonize(item));
      return JSON.stringify(sample, null, 2);
    }

    return JSON.stringify(skeletonize(data), null, 2);
  } catch {
    // JSONL — take first N lines
    const lines = content.split('\n').filter(l => l.trim()).slice(0, maxItems);
    return lines.map(line => {
      try { return JSON.stringify(skeletonize(JSON.parse(line)), null, 2); }
      catch { return line.slice(0, 200); }
    }).join('\n');
  }
}

function skeletonize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (typeof obj === 'string') {
    // Keep short strings intact (likely enums, roles, types, timestamps)
    if (obj.length <= 40) return obj;
    // Replace long strings with type marker
    return `[STRING, ${obj.length} chars]`;
  }
  if (Array.isArray(obj)) {
    // Keep first 2 items to show structure, indicate total
    const sample = obj.slice(0, 2).map(item => skeletonize(item));
    if (obj.length > 2) sample.push(`[...${obj.length - 2} more items]` as unknown);
    return sample;
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = skeletonize(value);
    }
    return result;
  }
  return obj;
}

/**
 * Generate a structural signature for schema caching.
 * Hash of field names + nesting structure (ignoring values).
 * Same structure → same hash → cached schema reused.
 */
export function structuralSignature(content: string): string {
  try {
    const data = JSON.parse(content);
    const item = Array.isArray(data) ? data[0] : data;
    const sig = extractFieldPaths(item).sort().join('|');
    return simpleHash(sig);
  } catch {
    // JSONL
    const firstLine = content.split('\n')[0]?.trim();
    if (!firstLine) return 'unknown';
    try {
      const sig = extractFieldPaths(JSON.parse(firstLine)).sort().join('|');
      return simpleHash(sig);
    } catch { return 'unknown'; }
  }
}

function extractFieldPaths(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix + ':' + typeof obj];
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [prefix + ':[]'];
    return extractFieldPaths(obj[0], prefix + '[]');
  }
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    paths.push(...extractFieldPaths(value, prefix ? `${prefix}.${key}` : key));
  }
  return paths;
}

// ── Generic Schema-Driven Parser ──────────────────────────────────────

/** Navigate nested paths like "author.role" or "chat_messages" */
function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce((current: unknown, key: string) => {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Parse content using an AI-inferred SchemaMapping.
 * Works with any JSON structure — the schema tells it where to find everything.
 */
export function parseWithSchema(content: string, schema: SchemaMapping): ParseResult {
  const warnings: string[] = [];
  const conversations: ConversationPayload[] = [];

  try {
    const data = JSON.parse(content);

    // Navigate to conversations array
    let convArray: unknown[];
    if (schema.conversationsPath === 'root') {
      convArray = Array.isArray(data) ? data : [data];
    } else {
      const nested = getNestedValue(data, schema.conversationsPath);
      convArray = Array.isArray(nested) ? nested : nested ? [nested] : [];
    }

    for (let i = 0; i < convArray.length; i++) {
      const conv = convArray[i] as Record<string, unknown>;
      const id = String(getNestedValue(conv, schema.fields.id) || `item-${i}`);
      const title = getNestedValue(conv, schema.fields.title);
      const createdAt = String(getNestedValue(conv, schema.fields.createdAt) || new Date().toISOString());

      // Extract messages
      const rawMessages = getNestedValue(conv, schema.messageFields.path);
      const messageArray = Array.isArray(rawMessages) ? rawMessages : [];
      const messages: CapturedMessage[] = [];

      for (let j = 0; j < messageArray.length; j++) {
        const msg = messageArray[j] as Record<string, unknown>;

        // Get role
        const rawRole = String(getNestedValue(msg, schema.messageFields.role) || '');
        const role = schema.messageFields.roleMap[rawRole] || rawRole;
        if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;

        // Get content
        let msgContent = '';
        if (schema.messageFields.contentArray) {
          const ca = schema.messageFields.contentArray;
          const blocks = getNestedValue(msg, ca.path);
          if (Array.isArray(blocks)) {
            msgContent = blocks
              .filter((b: Record<string, unknown>) => ca.includeTypes.includes(String(b[ca.typeField])))
              .map((b: Record<string, unknown>) => String(b[ca.textField] || ''))
              .filter(Boolean)
              .join('\n');
          }
        }

        // Fallback to simple string field
        if (!msgContent) {
          const simpleContent = getNestedValue(msg, schema.messageFields.content);
          msgContent = simpleContent ? String(simpleContent) : '';
        }

        if (!msgContent.trim()) continue;

        const timestamp = schema.messageFields.timestamp
          ? getNestedValue(msg, schema.messageFields.timestamp)
          : undefined;

        messages.push({
          role: role as 'user' | 'assistant' | 'system',
          content: msgContent,
          timestamp: timestamp ? String(timestamp) : undefined,
          sequence: messages.length,
        });
      }

      if (messages.length === 0) {
        warnings.push(`Conversation "${title || id}" has no valid messages, skipping`);
        continue;
      }

      const convUrl = schema.fields.url
        ? String(getNestedValue(conv, schema.fields.url) || `imported://${id}`)
        : `imported://${id}`;

      conversations.push({
        platform: schema.platform,
        platformConversationId: id,
        title: title ? String(title) : null,
        url: convUrl,
        messages,
        metadata: { source: schema.formatName, parsedWith: 'ai-schema-inference' },
        capturedAt: createdAt,
      });
    }
  } catch (err) {
    warnings.push(`Schema-based parsing failed: ${String(err)}`);
  }

  return { conversations, warnings, format: 'claude-export' };
}

// ── Claude.ai Export Parser ─────────────────────────────────────────────

interface ClaudeContentBlock {
  type: 'p' | 'pre' | 'table' | string;
  data: string;
  language?: string;
}

interface ClaudeChatEntry {
  index: number;
  type: 'prompt' | 'response';
  message: ClaudeContentBlock[];
}

interface ClaudeExport {
  meta: {
    title: string;
    exported_at: string;
  };
  chats: ClaudeChatEntry[];
}

function formatClaudeContent(blocks: ClaudeContentBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === 'pre') {
        const lang = block.language || '';
        return `\`\`\`${lang}\n${block.data}\n\`\`\``;
      }
      return block.data;
    })
    .join('\n\n');
}

export function parseClaudeExport(jsonString: string): ParseResult {
  const warnings: string[] = [];
  const conversations: ConversationPayload[] = [];

  try {
    const data = JSON.parse(jsonString);

    // Handle single conversation export
    if (data.meta && data.chats) {
      const conv = parseSingleClaudeConversation(data as ClaudeExport, warnings);
      if (conv) conversations.push(conv);
    }
    // Handle array of conversations (bulk export)
    else if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (item.meta && item.chats) {
          const conv = parseSingleClaudeConversation(item as ClaudeExport, warnings);
          if (conv) conversations.push(conv);
        } else {
          warnings.push(`Item ${i} in array does not match Claude export format, skipping`);
        }
      }
    }
  } catch (err) {
    warnings.push(`Failed to parse JSON: ${String(err)}`);
  }

  return { conversations, warnings, format: 'claude-export' };
}

function parseSingleClaudeConversation(
  data: ClaudeExport,
  warnings: string[]
): ConversationPayload | null {
  const { meta, chats } = data;

  if (!chats || chats.length === 0) {
    warnings.push(`Conversation "${meta?.title || 'Untitled'}" has no messages, skipping`);
    return null;
  }

  const messages: CapturedMessage[] = [];
  for (let i = 0; i < chats.length; i++) {
    const entry = chats[i];
    const role: 'user' | 'assistant' = entry.type === 'prompt' ? 'user' : 'assistant';
    const content = formatClaudeContent(entry.message || []);

    if (!content.trim()) {
      warnings.push(`Message ${i} in "${meta?.title || 'Untitled'}" is empty`);
    }

    messages.push({
      role,
      content,
      sequence: i,
    });
  }

  const title = meta?.title || null;
  const firstContent = messages[0]?.content || '';
  const id = simpleHash((title || '') + firstContent);

  // Parse exported_at — could be "YYYY-MM-DD HH:MM:SS" or ISO 8601
  let capturedAt: string;
  try {
    capturedAt = new Date(meta.exported_at).toISOString();
  } catch {
    capturedAt = new Date().toISOString();
  }

  return {
    platform: 'claude',
    platformConversationId: `import-${id}`,
    title,
    url: `https://claude.ai/chat/imported-${id}`,
    messages,
    metadata: { source: 'claude-export', exportedAt: meta.exported_at },
    capturedAt,
  };
}

// ── ChatGPT Export Parser ───────────────────────────────────────────────

interface ChatGPTMessage {
  id: string;
  author: { role: string; metadata?: Record<string, unknown> };
  content: { content_type: string; parts?: unknown[] };
  create_time: number | null;
  end_turn?: boolean;
  weight?: number;
  metadata?: Record<string, unknown>;
}

interface ChatGPTNode {
  id: string;
  message: ChatGPTMessage | null;
  parent: string | null;
  children: string[];
}

interface ChatGPTConversation {
  id: string;
  title: string;
  create_time: number;
  update_time: number;
  current_node: string;
  mapping: Record<string, ChatGPTNode>;
}

function walkChatGPTTree(
  mapping: Record<string, ChatGPTNode>,
  currentNode: string,
  warnings: string[],
  convTitle: string
): CapturedMessage[] {
  // Trace path from current_node back to root
  const path: string[] = [];
  let nodeId: string | null = currentNode;
  const visited = new Set<string>();

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    path.unshift(nodeId);
    nodeId = mapping[nodeId]?.parent ?? null;
  }

  // Collect messages along the path
  const messages: CapturedMessage[] = [];
  let sequence = 0;

  for (const id of path) {
    const node = mapping[id];
    if (!node?.message) continue;

    const msg = node.message;
    const role = msg.author?.role;
    if (!role || (role !== 'user' && role !== 'assistant' && role !== 'system')) continue;

    // Skip non-text content
    if (msg.content?.content_type && msg.content.content_type !== 'text') {
      warnings.push(`Non-text content (${msg.content.content_type}) in "${convTitle}", skipping message`);
      continue;
    }

    // Extract text from parts
    const parts = msg.content?.parts || [];
    const textParts = parts.filter((p): p is string => typeof p === 'string');
    const content = textParts.join('\n');

    if (!content.trim()) continue;

    messages.push({
      role: role as 'user' | 'assistant' | 'system',
      content,
      timestamp: msg.create_time ? unixToISO(msg.create_time) : undefined,
      sequence: sequence++,
    });
  }

  return messages;
}

export function parseChatGPTExport(jsonString: string): ParseResult {
  const warnings: string[] = [];
  const conversations: ConversationPayload[] = [];

  try {
    const data = JSON.parse(jsonString);

    if (!Array.isArray(data)) {
      warnings.push('ChatGPT export should be an array of conversations');
      return { conversations, warnings, format: 'chatgpt-export' };
    }

    for (let i = 0; i < data.length; i++) {
      const conv = data[i] as ChatGPTConversation;

      if (!conv.mapping || !conv.current_node) {
        warnings.push(`Conversation ${i} ("${conv.title || 'Untitled'}") has no mapping, skipping`);
        continue;
      }

      // Walk the tree to get linear message sequence
      const messages = walkChatGPTTree(conv.mapping, conv.current_node, warnings, conv.title || 'Untitled');

      if (messages.length === 0) {
        warnings.push(`Conversation "${conv.title || 'Untitled'}" has no valid messages, skipping`);
        continue;
      }

      conversations.push({
        platform: 'chatgpt',
        platformConversationId: conv.id,
        title: conv.title || null,
        url: `https://chatgpt.com/c/${conv.id}`,
        messages,
        metadata: {
          source: 'chatgpt-export',
          createTime: conv.create_time,
          updateTime: conv.update_time,
        },
        capturedAt: conv.create_time ? unixToISO(conv.create_time) : new Date().toISOString(),
      });
    }
  } catch (err) {
    warnings.push(`Failed to parse JSON: ${String(err)}`);
  }

  return { conversations, warnings, format: 'chatgpt-export' };
}

// ── Claude Code JSONL Parser ────────────────────────────────────────────

interface ClaudeCodeEntry {
  sessionId: string;
  type: 'user' | 'assistant';
  message: {
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string }>;
  };
  uuid: string;
  timestamp: string;
  cwd?: string;
  slug?: string;
  model?: string;
  isSidechain?: boolean;
}

function extractClaudeCodeContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text!)
    .join('\n');
}

export function parseClaudeCodeJSONL(jsonlString: string): ParseResult {
  const warnings: string[] = [];
  const conversations: ConversationPayload[] = [];

  // Parse lines
  const lines = jsonlString.split('\n').filter(line => line.trim());
  const entries: ClaudeCodeEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      warnings.push(`Line ${i + 1}: failed to parse JSON, skipping`);
    }
  }

  // Group by sessionId
  const sessions = new Map<string, ClaudeCodeEntry[]>();
  for (const entry of entries) {
    if (!entry.sessionId) continue;
    // Skip sidechain messages (subagent internal)
    if (entry.isSidechain) continue;

    const group = sessions.get(entry.sessionId) || [];
    group.push(entry);
    sessions.set(entry.sessionId, group);
  }

  // Convert each session to a conversation
  for (const [sessionId, sessionEntries] of sessions) {
    // Sort by timestamp
    sessionEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const messages: CapturedMessage[] = [];
    for (let i = 0; i < sessionEntries.length; i++) {
      const entry = sessionEntries[i];
      const content = extractClaudeCodeContent(entry.message?.content);

      if (!content.trim()) continue;

      messages.push({
        role: entry.message?.role || entry.type,
        content,
        timestamp: entry.timestamp,
        sequence: i,
      });
    }

    if (messages.length === 0) {
      warnings.push(`Session ${sessionId.slice(0, 8)}... has no valid messages, skipping`);
      continue;
    }

    // Derive title from slug or cwd
    const firstEntry = sessionEntries[0];
    let title: string | null = null;
    if (firstEntry.slug) {
      title = titleCase(firstEntry.slug);
    } else if (firstEntry.cwd) {
      const parts = firstEntry.cwd.split('/');
      title = parts[parts.length - 1] || 'Claude Code Session';
    }

    conversations.push({
      platform: 'other',
      platformConversationId: sessionId,
      title,
      url: `claude-code://session/${sessionId}`,
      messages,
      metadata: {
        source: 'claude-code',
        cwd: firstEntry.cwd,
        slug: firstEntry.slug,
        model: firstEntry.model,
      },
      capturedAt: firstEntry.timestamp || new Date().toISOString(),
    });
  }

  return { conversations, warnings, format: 'claude-code-jsonl' };
}

// ── OpenClaw Workspace Parser ───────────────────────────────────────────

interface OpenClawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string }>;
}

function extractOpenClawContent(content: OpenClawMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map(block => {
      if (block.type === 'text' && block.text) return block.text;
      if (block.type === 'tool_use' && block.name) {
        const input = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
        return `[Tool: ${block.name}${input ? ` — ${input}` : ''}]`;
      }
      if (block.type === 'tool_result') {
        const text = typeof block.text === 'string' ? block.text : '';
        return text ? `[Result: ${text.slice(0, 200)}]` : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function parseOpenClaw(jsonlString: string): ParseResult {
  const warnings: string[] = [];
  const conversations: ConversationPayload[] = [];

  const lines = jsonlString.split('\n').filter(line => line.trim());
  const messages: CapturedMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]) as OpenClawMessage;
      if (!entry.role) {
        warnings.push(`Line ${i + 1}: missing role, skipping`);
        continue;
      }

      // Only keep user and assistant messages
      if (entry.role !== 'user' && entry.role !== 'assistant') continue;

      const content = extractOpenClawContent(entry.content);
      if (!content.trim()) continue;

      messages.push({
        role: entry.role,
        content,
        sequence: messages.length,
      });
    } catch {
      warnings.push(`Line ${i + 1}: failed to parse JSON, skipping`);
    }
  }

  if (messages.length === 0) {
    warnings.push('No valid messages found in OpenClaw session');
    return { conversations, warnings, format: 'openclaw-workspace' };
  }

  // Derive title from first user message
  const firstUserMsg = messages.find(m => m.role === 'user');
  const title = firstUserMsg
    ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ') + (firstUserMsg.content.length > 60 ? '...' : '')
    : 'OpenClaw Session';

  const id = simpleHash(messages.map(m => m.content.slice(0, 50)).join(''));

  conversations.push({
    platform: 'openclaw',
    platformConversationId: `openclaw-${id}`,
    title,
    url: `openclaw://session/${id}`,
    messages,
    metadata: { source: 'openclaw-workspace' },
    capturedAt: new Date().toISOString(),
  });

  return { conversations, warnings, format: 'openclaw-workspace' };
}

export function parseOpenClawMultiSession(
  files: Array<{ name: string; content: string }>,
  sessionsJson?: string
): ParseResult {
  const warnings: string[] = [];
  const conversations: ConversationPayload[] = [];

  // Parse optional sessions.json for metadata enrichment
  let sessionsMeta: Record<string, { model?: string; channel?: string; displayName?: string; updatedAt?: string }> = {};
  if (sessionsJson) {
    try {
      const parsed = JSON.parse(sessionsJson);
      const sessions = parsed.sessions || parsed;
      if (Array.isArray(sessions)) {
        for (const s of sessions) {
          if (s.sessionId) {
            sessionsMeta[s.sessionId] = {
              model: s.model,
              channel: s.channel,
              displayName: s.displayName,
              updatedAt: s.updatedAt,
            };
          }
        }
      }
    } catch {
      warnings.push('sessions.json: failed to parse, continuing without metadata');
    }
  }

  for (const file of files) {
    if (file.name === 'sessions.json') continue;

    const result = parseOpenClaw(file.content);
    warnings.push(...result.warnings.map(w => `${file.name}: ${w}`));

    // Enrich with session metadata if available
    const sessionId = file.name.replace(/\.jsonl$/, '');
    const meta = sessionsMeta[sessionId];

    for (const conv of result.conversations) {
      if (meta) {
        conv.metadata = {
          ...conv.metadata,
          model: meta.model,
          channel: meta.channel,
          displayName: meta.displayName,
        };
        if (meta.displayName) conv.title = meta.displayName;
        if (meta.updatedAt) conv.capturedAt = meta.updatedAt;
      }

      conv.platformConversationId = `openclaw-${sessionId}`;
      conversations.push(conv);
    }
  }

  return { conversations, warnings, format: 'openclaw-workspace' };
}
