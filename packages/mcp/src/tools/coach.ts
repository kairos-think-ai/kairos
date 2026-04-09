/**
 * kairos_coach — Live conversation analysis + coaching.
 *
 * Layer 2 of the coaching architecture. Accepts the current conversation
 * messages, runs structural engagement classification, compares to the
 * user's historical baseline, and returns coaching guidance.
 *
 * Context sources (in priority order):
 *   1. Session JSONL file (Claude Code — read from disk)
 *   2. Extension buffer (Claude.ai — captured in real-time)
 *   3. Claude-passed messages (all platforms — unreliable but universal)
 *   4. Fallback: historical profile only (degrades to Layer 1)
 *
 * No LLM calls. All classification is structural (<100ms).
 */

import { from } from "../db.js";
import {
  classifyLiveMessages,
  detectDriftFromText,
  compareToBaseline,
  generateCoachingGuidance,
  type CoachMessage,
  type StoredBaseline,
  type CoachingOutput,
} from "@kairos/core";
import { computeEngagementProfile } from "@kairos/core";

interface CoachInput {
  /** Current conversation messages. Claude passes these as a tool parameter. */
  messages?: Array<{ role: string; content: string }>;
  /** Optional: what the user is trying to accomplish */
  intent?: string;
  /** Optional: coaching focus area */
  focus?: "engagement" | "drift" | "ideas" | "all";
  /** Optional: path to Claude Code session JSONL file */
  sessionFile?: string;
}

export async function handleCoach(args: CoachInput) {
  try {
    const focus = args.focus || "all";

    // ── Resolve conversation messages ────────────────────────────

    let messages: CoachMessage[] = [];

    // Priority 1: Read from session file (Claude Code)
    if (args.sessionFile) {
      messages = await readSessionFile(args.sessionFile);
    }

    // Priority 2: Use Claude-passed messages
    if (messages.length === 0 && args.messages && args.messages.length > 0) {
      messages = args.messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
              : String(m.content),
        }));
    }

    // Priority 3: No messages — return profile-only response
    if (messages.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No conversation messages available to analyze. " +
            "Try passing messages or specifying a session file path. " +
            "Falling back to historical profile — use kairos_reflect for full details.",
        }],
      };
    }

    // ── Step 1-3: Live classification ────────────────────────────

    const { classifications, questionDensity, selfCorrectionCount } =
      classifyLiveMessages(messages);

    const liveProfile = computeEngagementProfile(classifications);

    // ── Step 4: Drift detection ──────────────────────────────────

    const drift = detectDriftFromText(messages, args.intent);

    // ── Step 5: Fetch historical baseline ────────────────────────

    const baseline = await fetchBaseline();

    // ── Step 6: Compare to baseline ──────────────────────────────

    const deviations = baseline
      ? compareToBaseline(liveProfile, baseline, questionDensity, selfCorrectionCount)
      : [];

    // ── Step 5b: Fetch relevant ideas ────────────────────────────

    let relevantIdeas: Array<{ summary: string; importance: number }> = [];
    if (focus === "all" || focus === "ideas") {
      relevantIdeas = await fetchRelevantIdeas(messages);
    }

    // ── Step 7: Generate coaching ────────────────────────────────

    const recentStates = classifications.slice(-10).map(c => c.state);
    const coaching = generateCoachingGuidance(deviations, drift, recentStates, relevantIdeas);

    // ── Format response ──────────────────────────────────────────

    const output: CoachingOutput = {
      currentConversation: {
        turnsAnalyzed: classifications.length,
        classifications,
        profile: liveProfile,
        drift,
        recentTrend: {
          lastNStates: recentStates,
          consecutivePassive: countTrailing(recentStates, "PASSIVE_ACCEPTANCE"),
        },
      },
      deviations,
      coaching,
    };

    // Format as readable text for Claude
    const text = formatCoachingResponse(output, baseline);

    return {
      content: [{ type: "text" as const, text }],
    };
  } catch (err) {
    return {
      content: [{
        type: "text" as const,
        text: `Coach analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      }],
      isError: true,
    };
  }
}

// ── Data Fetching ────────────────────────────────────────────────────

async function fetchBaseline(): Promise<StoredBaseline | null> {
  const { data: engagedConvos } = await from("conversations")
    .select("engagement_profile")
    .neq("engagement_profile", "null")
    .order("started_at", { ascending: false })
    .limit(50);

  const profiles = (engagedConvos || [])
    .map((c: any) => c.engagement_profile)
    .filter(Boolean);

  if (profiles.length === 0) return null;

  const avg = (key: string) => {
    const vals = profiles.map((p: any) => p[key] || 0);
    return vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
  };

  return {
    verificationRate: avg("verificationRate"),
    generationRatio: avg("generationRatio"),
    passiveAcceptanceRate: avg("passiveAcceptanceRate"),
  };
}

async function fetchRelevantIdeas(
  messages: CoachMessage[],
): Promise<Array<{ summary: string; importance: number }>> {
  // Extract topic keywords from recent user messages
  const recentUserText = messages
    .filter(m => m.role === "user")
    .slice(-5)
    .map(m => m.content)
    .join(" ");

  // Simple keyword search in ideas
  const words = recentUserText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const searchTerms = [...new Set(words)].slice(0, 3);

  if (searchTerms.length === 0) return [];

  // Search ideas by summary text
  const { data: ideas } = await from("ideas")
    .select("summary, importance_score")
    .order("importance_score", { ascending: false })
    .limit(20);

  if (!ideas || ideas.length === 0) return [];

  // Score ideas by keyword overlap with current conversation
  const scored = ideas
    .map((idea: any) => {
      const ideaLower = (idea.summary || "").toLowerCase();
      const matchCount = searchTerms.filter(term => ideaLower.includes(term)).length;
      return { summary: idea.summary, importance: idea.importance_score || 0, matchCount };
    })
    .filter(i => i.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount || b.importance - a.importance);

  return scored.slice(0, 3).map(i => ({ summary: i.summary, importance: i.importance }));
}

// ── Session File Reading ─────────────────────────────────────────────

async function readSessionFile(filePath: string): Promise<CoachMessage[]> {
  try {
    const fs = await import("fs");
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());

    const messages: CoachMessage[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user" && entry.message?.content) {
          const content = typeof entry.message.content === "string"
            ? entry.message.content
            : "";
          if (content) messages.push({ role: "user", content });
        } else if (entry.type === "assistant" && entry.message?.content) {
          // Extract text blocks from assistant content array
          const contentBlocks = entry.message.content;
          if (Array.isArray(contentBlocks)) {
            const text = contentBlocks
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n");
            if (text) messages.push({ role: "assistant", content: text });
          }
        }
      } catch {
        // Skip malformed lines (e.g., incomplete last line during active session)
        continue;
      }
    }

    return messages;
  } catch {
    return [];
  }
}

// ── Response Formatting ──────────────────────────────────────────────

function formatCoachingResponse(output: CoachingOutput, baseline: StoredBaseline | null): string {
  const { currentConversation: cc, deviations, coaching } = output;

  const sections: string[] = [];

  // Current conversation summary
  sections.push(
    `## Current Conversation Analysis\n` +
    `- Turns analyzed: ${cc.turnsAnalyzed}\n` +
    `- Dominant state: ${getDominantState(cc.profile)}\n` +
    `- Verification rate: ${(cc.profile.verificationRate * 100).toFixed(0)}%` +
    `${baseline ? ` (baseline: ${(baseline.verificationRate * 100).toFixed(0)}%)` : ""}\n` +
    `- Generation ratio: ${(cc.profile.generationRatio * 100).toFixed(0)}%` +
    `${baseline ? ` (baseline: ${(baseline.generationRatio * 100).toFixed(0)}%)` : ""}\n` +
    `- Passive acceptance: ${(cc.profile.passiveAcceptanceRate * 100).toFixed(0)}%` +
    `${baseline ? ` (baseline: ${(baseline.passiveAcceptanceRate * 100).toFixed(0)}%)` : ""}\n` +
    `- Drift: ${cc.drift.status}${cc.drift.description ? ` — ${cc.drift.description}` : ""}`
  );

  // Significant deviations
  const significant = deviations.filter(d => d.isSignificant);
  if (significant.length > 0) {
    sections.push(
      `## Alerts\n` +
      significant.map(d =>
        `- ${d.label}: ${(d.current * 100).toFixed(0)}% (${d.direction} than baseline ${(d.baseline * 100).toFixed(0)}%)`
      ).join("\n")
    );
  }

  // Coaching for Claude
  if (coaching.forClaude.length > 0) {
    sections.push(
      `## Guidance for Claude\n` +
      coaching.forClaude.map(c => `- ${c}`).join("\n")
    );
  }

  // Coaching for the user
  if (coaching.forUser.length > 0) {
    sections.push(
      `## Suggestions for the User\n` +
      coaching.forUser.map(c => `- ${c}`).join("\n")
    );
  }

  // All clear
  if (significant.length === 0 && coaching.forClaude.length === 0 && coaching.forUser.length === 0) {
    sections.push("## Status\nEngagement looks healthy. No coaching needed right now.");
  }

  return sections.join("\n\n");
}

function getDominantState(profile: any): string {
  const dist = profile.stateDistribution || {};
  const sorted = Object.entries(dist).sort((a: any, b: any) => b[1] - a[1]);
  if (sorted.length === 0) return "unknown";
  return `${sorted[0][0].replace(/_/g, " ")} (${((sorted[0][1] as number) * 100).toFixed(0)}%)`;
}

function countTrailing(states: string[], target: string): number {
  let count = 0;
  for (let i = states.length - 1; i >= 0; i--) {
    if (states[i] === target) count++;
    else break;
  }
  return count;
}
