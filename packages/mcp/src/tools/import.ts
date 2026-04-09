/**
 * kairos_import — Ingest conversation exports into the Kairos memory graph.
 *
 * Supported formats:
 *   - claude-export: ZIP containing conversations.json
 *   - chatgpt-export: JSON array of conversations
 *   - claude-code-jsonl: One JSON object per line
 *   - auto: Detect format from file extension and content
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";
import { from } from "../db.js";

interface CapturedMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  sequence: number;
}

interface ConversationPayload {
  platform: string;
  platformConversationId: string;
  title: string | null;
  messages: CapturedMessage[];
  capturedAt: string;
}

type ImportFormat = "claude-export" | "chatgpt-export" | "claude-code-jsonl" | "auto";

export async function handleImport(filePath: string, format: string) {
  try {
    const raw = await readFile(filePath);
    const detectedFormat = format === "auto" ? detectFormat(filePath, raw) : format as ImportFormat;
    let conversations: ConversationPayload[];

    switch (detectedFormat) {
      case "claude-export":
        conversations = await parseClaudeExport(raw);
        break;
      case "chatgpt-export":
        conversations = parseChatGPTExport(raw);
        break;
      case "claude-code-jsonl":
        conversations = parseClaudeCodeJSONL(raw);
        break;
      default:
        return { content: [{ type: "text" as const, text: `Unknown format: ${detectedFormat}. Supported: claude-export, chatgpt-export, claude-code-jsonl` }] };
    }

    if (conversations.length === 0) {
      return { content: [{ type: "text" as const, text: "No conversations found in the file." }] };
    }

    // Store in Supabase
    const { stored, skipped, errors } = await storeConversations(conversations);

    return {
      content: [{
        type: "text" as const,
        text: `Imported ${stored} conversations (${skipped} duplicates skipped, ${errors} errors).\n` +
              `Format: ${detectedFormat}\n` +
              `Total messages: ${conversations.reduce((sum, c) => sum + c.messages.length, 0)}\n` +
              `Conversations are queued for analysis. Use kairos_recall to search them.`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Import failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

function detectFormat(filePath: string, raw: Buffer): ImportFormat {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".zip") return "claude-export";
  if (ext === ".jsonl") return "claude-code-jsonl";
  if (ext === ".json") {
    const text = raw.toString("utf-8", 0, 500);
    // Claude exports have uuid + chat_messages
    if (text.includes('"chat_messages"') || text.includes('"uuid"')) return "claude-export";
    // ChatGPT exports have mapping + message nodes
    if (text.includes('"mapping"')) return "chatgpt-export";
    if (text.trimStart().startsWith("[")) return "chatgpt-export";
  }
  return "chatgpt-export"; // fallback
}

async function parseClaudeExport(raw: Buffer): Promise<ConversationPayload[]> {
  let data: any;

  // Handle both ZIP and raw JSON
  try {
    const zip = await JSZip.loadAsync(raw);
    const jsonFile = zip.file("conversations.json") || zip.file(/conversations\.json$/i)[0];
    if (!jsonFile) throw new Error("not a zip");
    const text = await jsonFile.async("text");
    data = JSON.parse(text);
  } catch {
    // Not a ZIP — try parsing as raw JSON
    data = JSON.parse(raw.toString("utf-8"));
  }
  const convos = Array.isArray(data) ? data : [data];

  return convos.map((c: any) => ({
    platform: "claude" as const,
    platformConversationId: c.uuid || c.id || crypto.randomUUID(),
    title: c.name || c.title || null,
    messages: (c.chat_messages || c.messages || []).map((m: any, i: number) => ({
      role: mapRole(m.sender || m.role),
      content: extractContent(m),
      timestamp: m.created_at || m.timestamp,
      sequence: i,
    })),
    capturedAt: c.created_at || new Date().toISOString(),
  }));
}

function parseChatGPTExport(raw: Buffer): ConversationPayload[] {
  const data = JSON.parse(raw.toString("utf-8"));
  const convos = Array.isArray(data) ? data : [data];

  return convos.map((c: any) => {
    const messages = flattenChatGPTMessages(c.mapping || {});
    return {
      platform: "chatgpt" as const,
      platformConversationId: c.id || crypto.randomUUID(),
      title: c.title || null,
      messages,
      capturedAt: c.create_time
        ? new Date(c.create_time * 1000).toISOString()
        : new Date().toISOString(),
    };
  });
}

function flattenChatGPTMessages(mapping: Record<string, any>): CapturedMessage[] {
  const messages: CapturedMessage[] = [];
  let seq = 0;
  for (const node of Object.values(mapping)) {
    const msg = node?.message;
    if (!msg || !msg.content?.parts?.length) continue;
    const role = msg.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    messages.push({
      role: role as "user" | "assistant",
      content: msg.content.parts.filter((p: any) => typeof p === "string").join("\n"),
      timestamp: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : undefined,
      sequence: seq++,
    });
  }
  return messages;
}

function parseClaudeCodeJSONL(raw: Buffer): ConversationPayload[] {
  const lines = raw.toString("utf-8").split("\n").filter((l) => l.trim());
  return lines.map((line, i) => {
    const obj = JSON.parse(line);
    return {
      platform: "claude" as const,
      platformConversationId: obj.id || obj.session_id || `jsonl-${i}`,
      title: obj.title || obj.prompt?.slice(0, 80) || null,
      messages: (obj.messages || []).map((m: any, j: number) => ({
        role: mapRole(m.role),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        timestamp: m.timestamp,
        sequence: j,
      })),
      capturedAt: obj.timestamp || obj.created_at || new Date().toISOString(),
    };
  });
}

function mapRole(role: string): "user" | "assistant" | "system" {
  const map: Record<string, "user" | "assistant" | "system"> = {
    human: "user",
    user: "user",
    assistant: "assistant",
    ai: "assistant",
    system: "system",
  };
  return map[role?.toLowerCase()] || "assistant";
}

function extractContent(msg: any): string {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

async function getDefaultUserId(): Promise<string | null> {
  if (process.env.KAIROS_USER_ID) return process.env.KAIROS_USER_ID;
  const { data } = await from("users")
    .select("id")
    .limit(1)
    .maybeSingle();
  return data?.id || null;
}

async function storeConversations(conversations: ConversationPayload[]) {
  let stored = 0;
  let skipped = 0;
  let errors = 0;

  // Get the user — use configured KAIROS_USER_ID or fall back to first user
  const userId = process.env.KAIROS_USER_ID || await getDefaultUserId();
  if (!userId) {
    return { stored: 0, skipped: 0, errors: conversations.length };
  }

  for (const convo of conversations) {
    const { data: existing } = await from("conversations")
      .select("id")
      .eq("platform_conversation_id", convo.platformConversationId)
      .eq("platform", convo.platform)
      .eq("user_id", userId)
      .maybeSingle();

    if (existing) {
      skipped++;
      continue;
    }

    const { data: convRow, error: convErr } = await from("conversations")
      .insert({
        user_id: userId,
        platform: convo.platform,
        platform_conversation_id: convo.platformConversationId,
        title: convo.title,
        started_at: convo.capturedAt,
        message_count: convo.messages.length,
        analysis_status: "pending",
      })
      .select("id")
      .single();

    if (convErr || !convRow) {
      errors++;
      continue;
    }

    // Insert messages
    const messageBatch = convo.messages.map((m) => ({
      conversation_id: convRow.id,
      user_id: userId,
      role: m.role,
      content: m.content,
      sequence: m.sequence,
      timestamp: m.timestamp,
    }));

    if (messageBatch.length > 0) {
      const { error: msgErr } = await from("messages")
        .insert(messageBatch);
      if (msgErr) errors++;
    }

    stored++;
  }

  return { stored, skipped, errors };
}
