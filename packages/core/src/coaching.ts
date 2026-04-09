/**
 * Live Coaching Analysis — @kairos/core
 *
 * Three functions for the kairos_coach MCP tool:
 *   1. detectDriftFromText() — lightweight drift detection without embeddings
 *   2. compareToBaseline() — compare live conversation profile to historical averages
 *   3. generateCoachingGuidance() — compile deviations into natural language
 *
 * Design principle: These run on raw message text in real-time (<100ms).
 * No embeddings, no LLM calls, no database access.
 * The MCP tool handles data fetching; these are pure computation.
 */

import { getConfig } from "./config.js";
import {
  structuralClassify,
  computeEngagementProfile,
  type EngagementState,
  type TurnClassification,
  type ConversationEngagementProfile,
} from "./engagement.js";

// ── Types ───────────────────────────────────────��────────────────────

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface DriftSignal {
  status: "on_track" | "drifting" | "off_topic";
  description: string;
  /** Overlap ratio between early and recent keywords (0-1, higher = more on track) */
  overlapRatio: number;
}

export interface BaselineComparison {
  metric: string;
  label: string;
  current: number;
  baseline: number;
  deviation: number;     // current - baseline
  direction: "higher" | "lower" | "same";
  isSignificant: boolean; // deviation > threshold
}

export interface CoachingOutput {
  currentConversation: {
    turnsAnalyzed: number;
    classifications: TurnClassification[];
    profile: ConversationEngagementProfile;
    drift: DriftSignal;
    recentTrend: {
      lastNStates: EngagementState[];
      consecutivePassive: number;
    };
  };
  deviations: BaselineComparison[];
  coaching: {
    forClaude: string[];
    forUser: string[];
  };
}

export interface StoredBaseline {
  verificationRate: number;
  generationRatio: number;
  passiveAcceptanceRate: number;
  avgQuestionDensity?: number;
  avgSelfCorrections?: number;
}

// ── 1. Drift Detection From Text ─────────────────────────────────────

/**
 * Lightweight drift detection using keyword overlap.
 * Compares topics in early messages vs recent messages.
 * If an explicit intent is provided, compares recent messages against it.
 *
 * No embeddings needed — uses simple keyword extraction.
 *
 * @param messages - Full conversation messages (user + assistant)
 * @param intent - Optional: what the user said they wanted to do
 */
export function detectDriftFromText(
  messages: Message[],
  intent?: string,
): DriftSignal {
  if (messages.length < 4) {
    return { status: "on_track", description: "Too few messages to detect drift", overlapRatio: 1 };
  }

  const cfg = getConfig();
  const userMessages = messages.filter(m => m.role === "user");
  if (userMessages.length < cfg.coaching.minMessagesForDrift) {
    return { status: "on_track", description: "Too few user messages to detect drift reliably", overlapRatio: 1 };
  }

  // Split into early (first third) and recent (last third)
  const splitPoint = Math.max(1, Math.floor(userMessages.length / 3));
  const earlyMessages = userMessages.slice(0, splitPoint);
  const recentMessages = userMessages.slice(-splitPoint);

  const earlyKeywords = extractKeywords(earlyMessages.map(m => m.content).join(" "));
  const recentKeywords = extractKeywords(recentMessages.map(m => m.content).join(" "));

  // If intent provided, also compare recent to intent
  let referenceKeywords = earlyKeywords;
  if (intent) {
    const intentKeywords = extractKeywords(intent);
    // Merge intent keywords with early keywords (intent takes precedence)
    referenceKeywords = new Set([...intentKeywords, ...earlyKeywords]);
  }

  // Compute overlap
  const overlap = [...recentKeywords].filter(k => referenceKeywords.has(k)).length;
  const unionSize = new Set([...recentKeywords, ...referenceKeywords]).size;
  const overlapRatio = unionSize > 0 ? overlap / unionSize : 1;

  // Classify drift based on Jaccard-like overlap.
  // Conversations naturally narrow from broad to specific (e.g., "database schema" →
  // "threaded comments with ltree") — this is deepening, not drifting.
  // Lower thresholds account for this:
  //   >= 0.12: on_track (any meaningful keyword overlap means related topics)
  //   >= 0.04: drifting (very little overlap, but some connection)
  //   <  0.04: off_topic (essentially no shared vocabulary)
  if (overlapRatio >= cfg.coaching.driftOnTrackThreshold) {
    return {
      status: "on_track",
      description: "Conversation topics remain consistent",
      overlapRatio,
    };
  } else if (overlapRatio >= cfg.coaching.driftingThreshold) {
    return {
      status: "drifting",
      description: `Topic overlap has decreased. Early topics: ${[...earlyKeywords].slice(0, 5).join(", ")}. Recent topics: ${[...recentKeywords].slice(0, 5).join(", ")}`,
      overlapRatio,
    };
  } else {
    return {
      status: "off_topic",
      description: `Significant topic shift detected. Started with: ${[...earlyKeywords].slice(0, 5).join(", ")}. Now discussing: ${[...recentKeywords].slice(0, 5).join(", ")}`,
      overlapRatio,
    };
  }
}

/**
 * Extract meaningful keywords from text.
 * Removes stop words, keeps nouns/verbs/adjectives (approximated by length + frequency).
 */
function extractKeywords(text: string): Set<string> {
  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "shall", "this", "that",
    "these", "those", "i", "you", "he", "she", "it", "we", "they", "me",
    "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
    "what", "which", "who", "whom", "when", "where", "why", "how",
    "not", "no", "nor", "so", "if", "then", "than", "too", "very",
    "just", "about", "up", "out", "also", "as", "into", "some", "such",
    "there", "here", "all", "each", "every", "both", "more", "most",
    "other", "any", "many", "much", "few", "let", "like", "think",
    "know", "want", "need", "make", "get", "go", "see", "use", "try",
    "ok", "okay", "sure", "yes", "yeah", "right", "well", "now", "one",
    "two", "first", "new", "good", "way", "even", "because", "still",
  ]);

  const words = text.toLowerCase()
    .replace(/[^a-z\s-]/g, " ")  // Strip numbers and special chars — only keep letters
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Return unique words that appear meaningful (length > 3 or appear multiple times)
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  return new Set(
    Object.entries(freq)
      .filter(([word, count]) => word.length > 3 || count > 1)
      .map(([word]) => word)
  );
}

// ── 2. Baseline Comparison ───────────────────────────────────────────

/**
 * Compare a live conversation's engagement profile against the user's
 * historical baseline. Returns a list of deviations.
 *
 * Significance threshold: deviation > 0.15 (15 percentage points).
 * This is a reasonable starting point — should be validated with real data.
 *
 * @param liveProfile - Engagement profile computed from current conversation
 * @param baseline - User's historical average metrics
 * @param liveQuestionDensity - Question rate in current conversation (optional)
 * @param liveSelfCorrections - Self-correction count in current conversation (optional)
 */
export function compareToBaseline(
  liveProfile: ConversationEngagementProfile,
  baseline: StoredBaseline,
  liveQuestionDensity?: number,
  liveSelfCorrections?: number,
): BaselineComparison[] {
  const SIGNIFICANCE_THRESHOLD = getConfig().coaching.baselineSignificanceThreshold;
  const comparisons: BaselineComparison[] = [];

  function compare(
    metric: string,
    label: string,
    current: number,
    base: number,
  ): BaselineComparison {
    const deviation = current - base;
    const absDeviation = Math.abs(deviation);
    return {
      metric,
      label,
      current,
      baseline: base,
      deviation,
      direction: absDeviation < 0.02 ? "same" : deviation > 0 ? "higher" : "lower",
      isSignificant: absDeviation > SIGNIFICANCE_THRESHOLD,
    };
  }

  comparisons.push(compare(
    "verificationRate",
    "Verification rate",
    liveProfile.verificationRate,
    baseline.verificationRate,
  ));

  comparisons.push(compare(
    "generationRatio",
    "Idea generation rate",
    liveProfile.generationRatio,
    baseline.generationRatio,
  ));

  comparisons.push(compare(
    "passiveAcceptanceRate",
    "Passive acceptance rate",
    liveProfile.passiveAcceptanceRate,
    baseline.passiveAcceptanceRate,
  ));

  if (liveQuestionDensity != null && baseline.avgQuestionDensity != null) {
    comparisons.push(compare(
      "questionDensity",
      "Question density",
      liveQuestionDensity,
      baseline.avgQuestionDensity,
    ));
  }

  if (liveSelfCorrections != null && baseline.avgSelfCorrections != null) {
    // Normalize self-corrections per turn for comparison
    const livePerTurn = liveProfile.totalUserTurns > 0
      ? liveSelfCorrections / liveProfile.totalUserTurns
      : 0;
    const basePerTurn = baseline.avgSelfCorrections; // already per-conversation average
    comparisons.push(compare(
      "selfCorrectionRate",
      "Self-correction frequency",
      livePerTurn,
      basePerTurn,
    ));
  }

  return comparisons;
}

// ── 3. Coaching Guidance Generation ──────────────────────────────────

/**
 * Generate natural language coaching from deviations and context.
 * Pure template logic — no LLM needed.
 *
 * @param deviations - Significant deviations from baseline
 * @param drift - Current drift status
 * @param recentStates - Last N engagement states
 * @param relevantIdeas - Ideas from resurfacing/recall related to this topic
 */
export function generateCoachingGuidance(
  deviations: BaselineComparison[],
  drift: DriftSignal,
  recentStates: EngagementState[],
  relevantIdeas: Array<{ summary: string; importance: number }>,
): { forClaude: string[]; forUser: string[] } {
  const forClaude: string[] = [];
  const forUser: string[] = [];

  const significantDeviations = deviations.filter(d => d.isSignificant);

  // Passive acceptance alert
  const passiveDev = significantDeviations.find(d => d.metric === "passiveAcceptanceRate" && d.direction === "higher");
  if (passiveDev) {
    const consecutivePassive = countTrailingState(recentStates, "PASSIVE_ACCEPTANCE");
    if (consecutivePassive >= 3) {
      forClaude.push(
        `User has been passively accepting for ${consecutivePassive} consecutive turns. ` +
        `Ask them to evaluate your suggestion before continuing. Their usual passive rate is ${(passiveDev.baseline * 100).toFixed(0)}%, currently ${(passiveDev.current * 100).toFixed(0)}%.`
      );
      forUser.push(
        `You've accepted the last ${consecutivePassive} suggestions without questioning. ` +
        `What trade-offs or concerns do you see?`
      );
    } else {
      forClaude.push(
        `User's passive acceptance is higher than usual (${(passiveDev.current * 100).toFixed(0)}% vs baseline ${(passiveDev.baseline * 100).toFixed(0)}%). ` +
        `Invite them to share their perspective before proceeding.`
      );
      forUser.push(
        `You're accepting more suggestions than usual without evaluation. ` +
        `Try asking about one assumption in the last response.`
      );
    }
  }

  // Low verification alert
  const verifyDev = significantDeviations.find(d => d.metric === "verificationRate" && d.direction === "lower");
  if (verifyDev) {
    forClaude.push(
      `User hasn't been verifying claims (${(verifyDev.current * 100).toFixed(0)}% vs usual ${(verifyDev.baseline * 100).toFixed(0)}%). ` +
      `When making factual claims, proactively show your reasoning or cite sources.`
    );
    forUser.push(
      `You haven't questioned any claims this conversation (your usual rate is ${(verifyDev.baseline * 100).toFixed(0)}%). ` +
      `Try: "How do you know that?" or "What's the evidence for this?"`
    );
  }

  // Low generation alert
  const genDev = significantDeviations.find(d => d.metric === "generationRatio" && d.direction === "lower");
  if (genDev) {
    forClaude.push(
      `User is generating fewer of their own ideas than usual (${(genDev.current * 100).toFixed(0)}% vs ${(genDev.baseline * 100).toFixed(0)}%). ` +
      `Ask them what they think before offering your suggestion.`
    );
    forUser.push(
      `You're contributing fewer of your own ideas than usual. ` +
      `Before asking for the next suggestion, try writing down what YOU think the answer might be.`
    );
  }

  // Question density drop
  const questionDev = significantDeviations.find(d => d.metric === "questionDensity" && d.direction === "lower");
  if (questionDev) {
    forClaude.push(
      `User's question rate has dropped significantly (${(questionDev.current * 100).toFixed(0)}% vs ${(questionDev.baseline * 100).toFixed(0)}%). ` +
      `Pause and invite questions before continuing.`
    );
    forUser.push(
      `You've stopped asking questions. Your usual rate is ${(questionDev.baseline * 100).toFixed(0)}%. ` +
      `What's unclear or worth exploring deeper?`
    );
  }

  // Drift coaching
  if (drift.status === "drifting") {
    forClaude.push(
      `Conversation is drifting from original topic. ${drift.description}. ` +
      `Check if this shift is intentional.`
    );
    forUser.push(
      `You may be drifting from your original intent. ${drift.description}. ` +
      `Is this shift intentional?`
    );
  } else if (drift.status === "off_topic") {
    forClaude.push(
      `Significant topic shift detected. ${drift.description}. ` +
      `Ask the user if they want to return to the original topic or continue on the new path.`
    );
    forUser.push(
      `You've shifted significantly from where you started. ${drift.description}. ` +
      `Do you want to return to the original topic or keep exploring this?`
    );
  }

  // Relevant ideas from past conversations
  if (relevantIdeas.length > 0) {
    const topIdea = relevantIdeas[0];
    forClaude.push(
      `User has a relevant past insight: "${topIdea.summary}" (importance: ${topIdea.importance.toFixed(1)}). ` +
      `Reference this if applicable.`
    );
    forUser.push(
      `Relevant idea from a past conversation: "${topIdea.summary}". ` +
      `Does this apply here?`
    );
  }

  // Positive reinforcement (no significant deviations = doing well)
  if (significantDeviations.length === 0 && drift.status === "on_track") {
    const deepEngagement = recentStates.filter(s => s === "DEEP_ENGAGEMENT").length;
    if (deepEngagement >= recentStates.length * 0.5) {
      forClaude.push("User is deeply engaged and on track. Continue current approach.");
      forUser.push("You're deeply engaged and on track. Keep going.");
    }
  }

  return { forClaude, forUser };
}

// ── Helper: Classify Live Messages ───────────────────────────────────

/**
 * Classify all user turns in a conversation using the structural pre-classifier.
 * Returns classifications for turns where structural classification succeeds.
 * Turns that would need LLM classification return a DEEP_ENGAGEMENT default
 * (conservative — assumes engagement when uncertain).
 *
 * Design decision: For live coaching, we only use structural classification.
 * LLM classification would add latency and cost to every coach call.
 * The structural classifier catches the most actionable states
 * (PASSIVE_ACCEPTANCE, VERIFICATION) with high confidence.
 */
export function classifyLiveMessages(messages: Message[]): {
  classifications: TurnClassification[];
  questionDensity: number;
  selfCorrectionCount: number;
} {
  const classifications: TurnClassification[] = [];
  let questionCount = 0;
  let selfCorrectionCount = 0;
  let userMessageCount = 0;

  // Self-correction patterns (from behavioral-signals.ts)
  const SELF_CORRECTION = /\b(actually|wait|let me rethink|i was wrong|correction|no,? i meant|scratch that|on second thought|let me reconsider|i take that back|hmm,? actually|sorry,? i meant|let me revise|that's not what i meant|i misspoke)\b/i;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    userMessageCount++;
    if (msg.content.includes("?")) questionCount++;
    if (SELF_CORRECTION.test(msg.content)) selfCorrectionCount++;

    // Find the preceding assistant message for context
    let prevAssistant: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === "assistant") {
        prevAssistant = messages[j].content;
        break;
      }
    }

    // Structural classification (no topic change detection — would need embeddings)
    const result = structuralClassify(msg.content, prevAssistant, false);
    if (result) {
      classifications.push(result);
    } else {
      // Conservative default: assume DEEP_ENGAGEMENT when structural can't decide
      classifications.push({
        state: "DEEP_ENGAGEMENT",
        confidence: 0.5,
        method: "structural",
        reasoning: "Ambiguous turn — defaulted to DEEP_ENGAGEMENT (conservative)",
      });
    }
  }

  const questionDensity = userMessageCount > 0 ? questionCount / userMessageCount : 0;

  return { classifications, questionDensity, selfCorrectionCount };
}

// ── Helpers ──────────────────────────────────────────────────────────

function countTrailingState(states: EngagementState[], target: EngagementState): number {
  let count = 0;
  for (let i = states.length - 1; i >= 0; i--) {
    if (states[i] === target) count++;
    else break;
  }
  return count;
}
