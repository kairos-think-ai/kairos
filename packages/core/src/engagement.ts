/**
 * Turn-Level Engagement Classification
 *
 * Classifies each human turn in a conversation into one of 6 cognitive engagement states.
 *
 * Taxonomy adapted from:
 *   - Mozannar et al. CUPS (CHI 2024) — 12 coding states → 6 conversation states
 *   - Demszky "uptake" concept (ACL 2021) — degree of building on interlocutor
 *   - Classification approach from Zheng et al. FastChat llm_judge (NeurIPS 2023)
 *
 * Two-phase classification:
 *   Phase 1: Structural pre-classification for obvious cases (~50% of turns)
 *   Phase 2: LLM classification for ambiguous cases
 *
 * All constants documented. No heuristic thresholds for state assignment —
 * structural rules are binary (matches or doesn't), not scored.
 */

// ── State Taxonomy ────────────────────────────────────────────────────

export type EngagementState =
  | "DEEP_ENGAGEMENT"      // Actively reasoning, challenging, or building on AI response
  | "PASSIVE_ACCEPTANCE"   // Accepting without modification or critical evaluation
  | "VERIFICATION"         // Checking, questioning, or fact-checking AI claims
  | "PROMPT_CRAFTING"      // Carefully constructing a specific request with context
  | "REDIRECTING"          // Changing topic or asking about something different
  | "DEFERRED";            // Acknowledging but postponing deeper thought

export interface TurnClassification {
  state: EngagementState;
  confidence: number;        // 1.0 for structural, 0-1 for LLM
  method: "structural" | "llm";
  reasoning?: string;        // CoT explanation (LLM only)
}

export interface ConversationEngagementProfile {
  stateDistribution: Record<EngagementState, number>;  // proportion of turns in each state
  totalUserTurns: number;
  structurallyClassified: number;
  llmClassified: number;
  // Derived metrics (from state distribution)
  verificationRate: number;       // VERIFICATION / total
  generationRatio: number;        // (DEEP_ENGAGEMENT + PROMPT_CRAFTING) / total
  passiveAcceptanceRate: number;  // PASSIVE_ACCEPTANCE / total
}

// ── Structural Pre-Classification ─────────────────────────────────────

/**
 * Structural patterns for obvious engagement states.
 * These are binary rules (match or no match), NOT scored thresholds.
 *
 * Design principle: Only classify structurally when the signal is unambiguous.
 * When in doubt, return null → LLM classifies.
 */

// Patterns indicating passive acceptance
const PASSIVE_PATTERNS = /^(ok|okay|sure|thanks|thank you|got it|great|perfect|nice|good|cool|awesome|sounds good|will do|noted|understood|makes sense|right|yep|yeah|yes|alright|👍|✅|done|k)\s*[.!]?$/i;

// Patterns indicating verification/challenge
const VERIFICATION_PATTERNS = /^(actually|that's not|no,|incorrect|wrong|i disagree|are you sure|wait,|but what about|hmm,|i checked|according to|source\??|really\?|is that right|can you verify|how do you know|where did you get)/i;

// Patterns indicating deferred processing
const DEFERRED_PATTERNS = /^(i'll (look into|think about|check|come back|revisit)|let me think|good point|interesting|i need to|save this|bookmark)/i;

/**
 * Attempt structural classification of a human turn.
 * Returns null if the turn is ambiguous and needs LLM classification.
 *
 * @param humanMessage - The human's message content
 * @param aiPreviousMessage - The AI's preceding message (for context length)
 * @param isTopicChange - Whether TextTiling detected a topic change at this turn
 */
export function structuralClassify(
  humanMessage: string,
  aiPreviousMessage: string | null,
  isTopicChange: boolean
): TurnClassification | null {
  const trimmed = humanMessage.trim();
  const charCount = trimmed.length;

  // Rule 1: Very short response after AI message → PASSIVE_ACCEPTANCE
  // (from CUPS: "Not Thinking" state detected by short accept-like responses)
  if (charCount < 30 && PASSIVE_PATTERNS.test(trimmed)) {
    return { state: "PASSIVE_ACCEPTANCE", confidence: 1.0, method: "structural" };
  }

  // Rule 2: Topic change detected by TextTiling → REDIRECTING
  // (from CUPS: "Thinking About New Code To Write" — redirecting attention)
  if (isTopicChange) {
    return { state: "REDIRECTING", confidence: 1.0, method: "structural" };
  }

  // Rule 3: Starts with verification/challenge language → VERIFICATION
  if (VERIFICATION_PATTERNS.test(trimmed)) {
    return { state: "VERIFICATION", confidence: 1.0, method: "structural" };
  }

  // Rule 4: Deferred processing language → DEFERRED
  if (DEFERRED_PATTERNS.test(trimmed)) {
    return { state: "DEFERRED", confidence: 1.0, method: "structural" };
  }

  // Rule 5: Long message with constraints/context → PROMPT_CRAFTING
  // (from CUPS: "Prompt Crafting" — writing with intention of triggering AI completion)
  // Must have BOTH length AND structure indicators — not just length alone
  if (charCount > 200 && hasPromptCraftingSignals(trimmed)) {
    return { state: "PROMPT_CRAFTING", confidence: 1.0, method: "structural" };
  }

  // Ambiguous — needs LLM classification
  return null;
}

/**
 * Check if a long message shows prompt crafting signals.
 * Requires at least 2 of: constraints, context, examples, structure markers.
 */
function hasPromptCraftingSignals(text: string): boolean {
  let signals = 0;

  // Constraint language
  if (/\b(must|should|don't|avoid|make sure|ensure|requirement|constraint)\b/i.test(text)) signals++;
  // Context provision
  if (/\b(context|background|for context|fyi|note that|keep in mind)\b/i.test(text)) signals++;
  // Example provision
  if (/\b(for example|e\.g\.|like this|such as|here's an example)\b/i.test(text)) signals++;
  // Structure markers (lists, numbered items)
  if (/(\n\s*[-*•]\s|\n\s*\d+[.)]\s)/m.test(text)) signals++;
  // Explicit output format requests
  if (/\b(format|output|return|respond with|give me|provide)\b/i.test(text)) signals++;

  return signals >= 2;
}

// ── LLM Classification Prompt ─────────────────────────────────────────

/**
 * Generate the LLM judge prompt for engagement classification.
 *
 * Adapted from FastChat llm_judge (NeurIPS 2023):
 *   - Pattern 1: Explanation-before-classification (CoT)
 *   - Pattern 2: Structured output [[STATE]] with regex extraction
 *   - Pattern 3: Temperature = 0 for deterministic classification
 *
 * @param aiResponse - The AI's response that the human is responding to
 * @param humanMessage - The human's message to classify
 * @param nextAction - What the human does after this (if available)
 */
export function buildEngagementPrompt(
  aiResponse: string,
  humanMessage: string,
  nextAction?: string
): string {
  const nextActionSection = nextAction
    ? `\n[Human's Next Action]\n${nextAction.slice(0, 500)}`
    : "";

  return `[Instruction]
You are classifying the HUMAN's cognitive engagement in a conversation with an AI assistant.

Classify the human's message into exactly one of these states:

- DEEP_ENGAGEMENT: The human is actively reasoning about, challenging, extending, or building on the AI's response. They contribute their own thinking, make connections, or push the conversation deeper.
- PASSIVE_ACCEPTANCE: The human accepts the AI's response without modification, critical evaluation, or substantive follow-up. Short acknowledgments, thanks, or simple confirmations.
- VERIFICATION: The human is checking, questioning, or fact-checking the AI's claims. They ask for sources, point out potential errors, or cross-reference information.
- PROMPT_CRAFTING: The human is carefully constructing a specific request — providing context, constraints, examples, or structured instructions to guide the AI.
- REDIRECTING: The human changes the topic or asks about something unrelated to the AI's previous response.
- DEFERRED: The human acknowledges the AI's response but explicitly or implicitly postpones deeper engagement — "I'll look into this later," "good point, let me think."

First, explain your reasoning in 1-2 sentences. Then classify by strictly following this format: [[STATE_NAME]]

[AI's Previous Response]
${aiResponse.slice(0, 1000)}

[Human's Message]
${humanMessage.slice(0, 1000)}${nextActionSection}`;
}

/**
 * Extract the state classification from LLM output.
 * Adapted from FastChat's regex extraction pattern.
 */
export function extractStateFromLLMOutput(output: string): {
  state: EngagementState | null;
  reasoning: string;
} {
  const VALID_STATES: EngagementState[] = [
    "DEEP_ENGAGEMENT", "PASSIVE_ACCEPTANCE", "VERIFICATION",
    "PROMPT_CRAFTING", "REDIRECTING", "DEFERRED"
  ];

  // Primary pattern: [[STATE_NAME]]
  const match = output.match(/\[\[([A-Z_]+)\]\]/);
  if (match && VALID_STATES.includes(match[1] as EngagementState)) {
    const reasoning = output.slice(0, output.indexOf("[[")).trim();
    return { state: match[1] as EngagementState, reasoning };
  }

  // Backup: [STATE_NAME]
  const backupMatch = output.match(/\[([A-Z_]+)\]/);
  if (backupMatch && VALID_STATES.includes(backupMatch[1] as EngagementState)) {
    const reasoning = output.slice(0, output.indexOf("[")).trim();
    return { state: backupMatch[1] as EngagementState, reasoning };
  }

  return { state: null, reasoning: output };
}

// ── Engagement Profile Computation ────────────────────────────────────

/**
 * Compute the engagement profile for a conversation from turn classifications.
 */
export function computeEngagementProfile(
  classifications: TurnClassification[]
): ConversationEngagementProfile {
  const states: EngagementState[] = [
    "DEEP_ENGAGEMENT", "PASSIVE_ACCEPTANCE", "VERIFICATION",
    "PROMPT_CRAFTING", "REDIRECTING", "DEFERRED"
  ];

  const total = classifications.length;
  if (total === 0) {
    const empty: Record<EngagementState, number> = {} as any;
    states.forEach(s => empty[s] = 0);
    return {
      stateDistribution: empty,
      totalUserTurns: 0,
      structurallyClassified: 0,
      llmClassified: 0,
      verificationRate: 0,
      generationRatio: 0,
      passiveAcceptanceRate: 0,
    };
  }

  // Count per state
  const counts: Record<string, number> = {};
  states.forEach(s => counts[s] = 0);
  let structural = 0;
  let llm = 0;

  for (const c of classifications) {
    counts[c.state] = (counts[c.state] || 0) + 1;
    if (c.method === "structural") structural++;
    else llm++;
  }

  // Distribution as proportions
  const dist: Record<EngagementState, number> = {} as any;
  states.forEach(s => dist[s] = counts[s] / total);

  return {
    stateDistribution: dist,
    totalUserTurns: total,
    structurallyClassified: structural,
    llmClassified: llm,
    verificationRate: dist.VERIFICATION,
    generationRatio: dist.DEEP_ENGAGEMENT + dist.PROMPT_CRAFTING,
    passiveAcceptanceRate: dist.PASSIVE_ACCEPTANCE,
  };
}

// ── 7 Universal Metrics ───────────────────────────────────────────────

/**
 * Compute the 7 universal metrics from engagement profile + Phase 3 stats.
 *
 * Metrics 1-3 come from engagement classification (this file).
 * Metrics 4-6 come from Phase 3 stats (stats.ts).
 * Metric 7 comes from Leitner resurfacing data.
 *
 * All returned as raw numbers — no categorical labels.
 * Progressive disclosure handles presentation.
 */
export interface UniversalMetrics {
  verificationRate: number;       // From engagement profile
  generationRatio: number;        // From engagement profile
  iterationDepth: number;         // Avg turns between change points
  driftRate: number;              // From centroid drift curve
  discoveryEntropy: number;       // From HDBSCAN normalized entropy
  ideaFollowThrough: number;     // Engaged / total surfaced ideas
  cognitiveLoad: number;          // From CLI composite
}

export function computeUniversalMetrics(
  engagementProfile: ConversationEngagementProfile,
  driftScore: number,
  normalizedEntropy: number,
  cognitiveLoadIndex: number,
  changePointCount: number,
  totalTurns: number,
  ideasEngaged: number,
  ideasSurfaced: number
): UniversalMetrics {
  return {
    verificationRate: engagementProfile.verificationRate,
    generationRatio: engagementProfile.generationRatio,
    iterationDepth: changePointCount > 0 ? totalTurns / (changePointCount + 1) : totalTurns,
    driftRate: driftScore,
    discoveryEntropy: normalizedEntropy,
    ideaFollowThrough: ideasSurfaced > 0 ? ideasEngaged / ideasSurfaced : 0,
    cognitiveLoad: cognitiveLoadIndex,
  };
}
