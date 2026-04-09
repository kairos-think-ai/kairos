/**
 * Kairos Behavioral Signals Engine
 *
 * Derives subtle behavioral features from HOW people communicate with AI,
 * not just WHAT they say. These are the invisible behavioral signatures
 * of thinking patterns.
 *
 * Design principles:
 * - Pure computation on existing data (no new capture, no API calls)
 * - Works for BOTH Mirror and Analyst tiers (local analysis)
 * - Signals are observed, never judged (aligned with OIE non-prescriptive stance)
 * - Open-core compatible: this file ships in the community edition
 *
 * Three output levels:
 * 1. Conversation Engagement Profile — per-conversation behavioral snapshot
 * 2. Weekly Communication Fingerprint — aggregate behavioral metrics
 * 3. Interaction Style Classification — derived archetype from aggregate signals
 */

// ============================================================
// Types
// ============================================================

export interface MessageData {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string | null;
  sequence: number;
}

export interface ConversationData {
  id: string;
  platform: string;
  started_at: string;
  message_count: number;
  messages: MessageData[];
}

/** Per-conversation behavioral snapshot */
export interface ConversationEngagementProfile {
  conversationId: string;
  /** Message lengths in order: [msg1_len, msg2_len, ...] — user messages only */
  userMessageLengths: number[];
  /** Engagement arc: 'deepening' | 'plateauing' | 'disengaging' | 'variable' */
  engagementArc: 'deepening' | 'plateauing' | 'disengaging' | 'variable';
  /** Percentage of user messages containing questions (0-1) */
  questionDensity: number;
  /** Average seconds between consecutive user messages (null if < 2 user messages) */
  avgResponseCadenceSeconds: number | null;
  /** Count of self-correction markers in user messages */
  selfCorrectionCount: number;
  /** Average user message length in characters */
  avgUserMessageLength: number;
  /** Total user messages */
  userMessageCount: number;
  /** Total assistant messages */
  assistantMessageCount: number;
}

/** Aggregate weekly behavioral metrics */
export interface WeeklyCommunicationFingerprint {
  /** 24-element array: conversation count per hour (0-23) */
  peakHours: number[];
  /** Conversations per platform */
  platformDistribution: Record<string, number>;
  /** Average messages per conversation */
  avgConversationDepth: number;
  /** Average question density across conversations */
  avgQuestionDensity: number;
  /** Average self-correction count per conversation */
  metacognitionIndex: number;
  /** Total conversations in the period */
  totalConversations: number;
  /** Total user messages in the period */
  totalUserMessages: number;
  /** Avg user message length across all conversations */
  avgUserMessageLength: number;
  /** Conversation depth distribution: [short (1-5 msgs), medium (6-15), deep (16+)] */
  depthDistribution: { short: number; medium: number; deep: number };
  /** Platform switches per day (estimated from conversation timestamps) */
  platformSwitchesPerDay: number;
}

/** Interaction style archetype */
export type InteractionStyle = 'explorer' | 'director' | 'thinker' | 'synthesizer';

/** Kairos Fluency Score — composite 0-100 from 4 dimensions */
export interface KairosFluencyScore {
  total: number;                    // 0-100
  delegation: number;               // 0-25
  iteration: number;                // 0-25
  discernment: number;              // 0-25
  breadth: number;                  // 0-25
  label: 'emerging' | 'developing' | 'proficient' | 'fluent';
  observation: string;
  implication: string;
  experiment: string;
}

/** Human-AI relationship health signals */
export interface RelationshipHealthSignals {
  anthropomorphizationIndex: number | null;  // 0-1
  cognitiveSovereigntyScore: number | null;  // 0-1
  artifactDiscernment: number | null;        // 0-1
  anthropomorphizationOIE: { observation: string; implication: string; experiment: string } | null;
  sovereigntyOIE: { observation: string; implication: string; experiment: string } | null;
  discernmentOIE: { observation: string; implication: string; experiment: string } | null;
}

export interface InteractionStyleResult {
  style: InteractionStyle;
  confidence: number; // 0-1
  /** OIE-formatted observation for the user */
  observation: string;
  implication: string;
  experiment: string;
}

// ============================================================
// Constants
// ============================================================

/** Patterns that indicate self-correction / metacognition */
const SELF_CORRECTION_PATTERNS = [
  /\bactually\b/i,
  /\bwait\b/i,
  /\blet me rethink\b/i,
  /\bon second thought\b/i,
  /\bi realize\b/i,
  /\bi meant\b/i,
  /\bcorrection\b/i,
  /\bscratch that\b/i,
  /\bnever ?mind\b/i,
  /\bno,?\s+(what i|i)\b/i,
  /\bhmm,?\s+(actually|maybe)\b/i,
  /\blet me reconsider\b/i,
  /\bi was wrong\b/i,
  /\bto clarify\b/i,
  /\bi should have said\b/i,
];

// ---- Fluency Score: Delegation Quality ----
const DELEGATION_PATTERNS = {
  specificity: [
    /\b\d+\s*(words?|chars?|lines?|pages?|minutes?|hours?|days?|items?|steps?|examples?)\b/i,
    /\b(specifically|exactly|precisely)\b/i,
    /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b/, // Proper nouns (multi-word)
  ],
  formatRequest: [
    /\b(list|table|step[- ]by[- ]step|bullet|markdown|json|csv|yaml|xml)\b/i,
    /\b(format|structure|organize|arrange)\s+(it|this|them|the)\b/i,
    /\b(in the format|formatted as|output as)\b/i,
  ],
  contextProvision: [
    /\b(background|context|for reference|here'?s? (the|some|my)|i'?m working on)\b/i,
    /\b(the situation is|the goal is|what i need is)\b/i,
  ],
  constraintSetting: [
    /\b(don'?t|do not|avoid|never|must not|shouldn'?t)\b/i,
    /\b(only|just|limit(ed)? to|no more than|at most|keep it (under|short|brief|concise))\b/i,
    /\b(must|should|need to|has to|required)\b/i,
  ],
};

// ---- Fluency Score: Iteration Depth ----
const ITERATION_PATTERNS = [
  /\b(based on (that|this|your)|building on|expanding on|following up)\b/i,
  /\b(now (let'?s|can you|please)|next|also|additionally|furthermore)\b/i,
  /\b(taking (that|this) further|going deeper|let'?s (explore|dig into))\b/i,
  /\b(good[,.]?\s*(now|but|and|can))/i,
  /\b(okay[,.]?\s*(now|but|and|can))\b/i,
];

// ---- Fluency Score: Discernment ----
const DISCERNMENT_PATTERNS = {
  pushback: [
    /\b(that'?s? (not|wrong|incorrect)|i disagree|are you sure|i don'?t think)\b/i,
    /\b(actually,?\s*i think|no,?\s*(that|it|i)|wait,?\s*(that|is))\b/i,
    /\b(can you (double[- ]check|re-?check|verify)|that doesn'?t (seem|look|sound) right)\b/i,
    /\b(i'?m not (sure|convinced)|that contradicts|hmm,?\s*but)\b/i,
  ],
  verification: [
    /\b(source|reference|citation|evidence|proof|documentation)\b/i,
    /\b(how do you know|where (did|does) (that|this) come from|can you (cite|verify|confirm))\b/i,
    /\b(is that (accurate|correct|true|right)|according to)\b/i,
  ],
};

// ---- Relationship Health: Anthropomorphization ----
const ANTHROPOMORPHIZATION_PATTERNS = {
  relationship: [
    /\b(thank you|thanks|please|sorry|excuse me|appreciate)\b/i,
    /\b(you'?re? (great|amazing|smart|helpful|right|wrong|funny))\b/i,
    /\b(i (trust|like|love|hate|feel|believe) you)\b/i,
    /\b(you (understand|know|think|feel|believe|remember))\b/i,
    /\b(we (can|should|could|might|need to))\b/i,
    /\b(how are you|what do you think|do you (agree|mind|want))\b/i,
    /\b(your (opinion|thoughts|perspective|feelings|take))\b/i,
    /\b(between (us|you and me))\b/i,
    /\b(don'?t (worry|feel bad|be sorry))\b/i,
    /\b(i'?m? (sorry|grateful|glad) (that|to))\b/i,
    /\b(you'?re? (my|like a) (friend|partner|assistant|colleague))\b/i,
    /\b(honestly|frankly|truthfully)\b/i,
  ],
  tool: [
    /\b(generate|output|produce|compute|calculate|return|process)\b/i,
    /\b(input|parameter|config|setting|option|flag)\b/i,
    /\b(the (model|system|AI|tool|bot|assistant))\b/i,
    /\b(prompt|instruction|command|query|request)\b/i,
    /\b(format|structure|parse|extract|convert|transform)\b/i,
    /\b(endpoint|API|function|method|interface)\b/i,
    /\b(response|output) (quality|format|length|style)\b/i,
    /\b(token|context window|training data|fine-?tun)\b/i,
    /\b(use (it|this tool|the model) to)\b/i,
    /\b(run|execute|perform|apply|implement)\b/i,
    /\b(optimize|improve|refine|adjust|tweak) (the|my) (prompt|output|response)\b/i,
    /\b(batch|pipeline|workflow|automation)\b/i,
  ],
};

// ---- Relationship Health: Cognitive Sovereignty ----
const SOVEREIGNTY_PATTERNS = {
  sovereignty: [
    /\b(i think|i believe|in my (opinion|experience|view))\b/i,
    /\b(i'?ve? (noticed|realized|decided|concluded|determined))\b/i,
    /\b(my (hypothesis|theory|approach|plan|idea|strategy) is)\b/i,
    /\b(i (disagree|don'?t agree|see it differently|have a different))\b/i,
    /\b(let me (think|consider|evaluate|assess|weigh))\b/i,
    /\b(i'?m (not sure|uncertain|skeptical|questioning))\b/i,
    /\b(that'?s? (interesting but|a good point,? (but|however)))\b/i,
    /\b(i'?ll (decide|choose|determine|figure out))\b/i,
    /\b(on (one|the other) hand)\b/i,
    /\b(comparing|weighing|evaluating) (the|my) options\b/i,
  ],
  outsourcing: [
    /\b(what should i (do|think|choose|decide|use|pick))\b/i,
    /\b(just (tell|give) me (the|what|which))\b/i,
    /\b(you (decide|choose|pick|determine))\b/i,
    /\b(what'?s? (the best|the right|the correct|your recommendation))\b/i,
    /\b(i (can'?t|don'?t know how to) (decide|choose|figure out))\b/i,
    /\b(make (the|this) (decision|choice) for me)\b/i,
    /\b(whatever you (think|say|suggest|recommend))\b/i,
    /\b(i'?ll (just|go with|do) (whatever|what you said))\b/i,
  ],
};

// ---- Relationship Health: Artifact Discernment ----
const ARTIFACT_INDICATORS: RegExp[] = [
  /^#{1,3}\s/m,                    // Markdown headers
  /```[\s\S]+?```/,                // Code blocks
  /^\s*[-*]\s/m,                   // Bullet lists
  /^\s*\d+\.\s/m,                  // Numbered lists
  /\b(in (summary|conclusion)|to summarize|key (takeaways|points))\b/i,
  /\b(here'?s? (a|the) (complete|full|comprehensive))\b/i,
];

// ============================================================
// Feature 1: Conversation Engagement Profile
// ============================================================

/**
 * Compute behavioral signals for a single conversation.
 * Pure function — no side effects, no API calls.
 */
export function computeConversationProfile(
  conversationId: string,
  messages: MessageData[],
): ConversationEngagementProfile {
  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');

  // Message length progression (user messages only)
  const userMessageLengths = userMessages.map(m => m.content.length);

  // Question density: percentage of user messages containing '?'
  const questionsCount = userMessages.filter(m => m.content.includes('?')).length;
  const questionDensity = userMessages.length > 0
    ? questionsCount / userMessages.length
    : 0;

  // Response cadence: average time between consecutive user messages
  const avgResponseCadenceSeconds = computeResponseCadence(userMessages);

  // Self-correction markers
  const selfCorrectionCount = countSelfCorrections(userMessages);

  // Average user message length
  const avgUserMessageLength = userMessageLengths.length > 0
    ? userMessageLengths.reduce((sum, len) => sum + len, 0) / userMessageLengths.length
    : 0;

  // Engagement arc: analyze the progression of message lengths
  const engagementArc = classifyEngagementArc(userMessageLengths);

  return {
    conversationId,
    userMessageLengths,
    engagementArc,
    questionDensity,
    avgResponseCadenceSeconds,
    selfCorrectionCount,
    avgUserMessageLength,
    userMessageCount: userMessages.length,
    assistantMessageCount: assistantMessages.length,
  };
}

// ============================================================
// Feature 2: Weekly Communication Fingerprint
// ============================================================

/**
 * Compute aggregate behavioral metrics across multiple conversations.
 * Typically called with one week of conversations.
 */
export function computeWeeklyFingerprint(
  conversations: ConversationData[],
): WeeklyCommunicationFingerprint {
  // Peak hours: count conversations per hour of day
  const peakHours = new Array(24).fill(0);
  for (const conv of conversations) {
    const hour = new Date(conv.started_at).getHours();
    peakHours[hour]++;
  }

  // Platform distribution
  const platformDistribution: Record<string, number> = {};
  for (const conv of conversations) {
    platformDistribution[conv.platform] = (platformDistribution[conv.platform] || 0) + 1;
  }

  // Per-conversation profiles
  const profiles = conversations.map(conv =>
    computeConversationProfile(conv.id, conv.messages)
  );

  // Average conversation depth
  const avgConversationDepth = conversations.length > 0
    ? conversations.reduce((sum, c) => sum + c.message_count, 0) / conversations.length
    : 0;

  // Average question density
  const avgQuestionDensity = profiles.length > 0
    ? profiles.reduce((sum, p) => sum + p.questionDensity, 0) / profiles.length
    : 0;

  // Metacognition index: average self-corrections per conversation
  const metacognitionIndex = profiles.length > 0
    ? profiles.reduce((sum, p) => sum + p.selfCorrectionCount, 0) / profiles.length
    : 0;

  // Total user messages
  const totalUserMessages = profiles.reduce((sum, p) => sum + p.userMessageCount, 0);

  // Average user message length
  const totalLengthSum = profiles.reduce((sum, p) =>
    sum + p.avgUserMessageLength * p.userMessageCount, 0);
  const avgUserMessageLength = totalUserMessages > 0
    ? totalLengthSum / totalUserMessages
    : 0;

  // Depth distribution
  const depthDistribution = { short: 0, medium: 0, deep: 0 };
  for (const conv of conversations) {
    if (conv.message_count <= 5) depthDistribution.short++;
    else if (conv.message_count <= 15) depthDistribution.medium++;
    else depthDistribution.deep++;
  }

  // Platform switches per day
  const platformSwitchesPerDay = computePlatformSwitchesPerDay(conversations);

  return {
    peakHours,
    platformDistribution,
    avgConversationDepth: Math.round(avgConversationDepth * 10) / 10,
    avgQuestionDensity: Math.round(avgQuestionDensity * 100) / 100,
    metacognitionIndex: Math.round(metacognitionIndex * 100) / 100,
    totalConversations: conversations.length,
    totalUserMessages,
    avgUserMessageLength: Math.round(avgUserMessageLength),
    depthDistribution,
    platformSwitchesPerDay: Math.round(platformSwitchesPerDay * 10) / 10,
  };
}

// ============================================================
// Feature 3: Interaction Style Classification
// ============================================================

/**
 * Classify the user's dominant interaction style from their weekly fingerprint.
 * Returns an OIE-formatted result (observation, implication, experiment).
 *
 * Archetypes:
 * - Explorer: high question ratio, long conversations, productive drift
 * - Director: short prompts, low drift, action-item heavy
 * - Thinker: long pauses, self-corrections, deep conversations
 * - Synthesizer: cross-topic connections, broad vocabulary, varied platforms
 */
export function classifyInteractionStyle(
  fingerprint: WeeklyCommunicationFingerprint,
  profiles: ConversationEngagementProfile[],
): InteractionStyleResult {
  // Score each archetype
  const scores = {
    explorer: 0,
    director: 0,
    thinker: 0,
    synthesizer: 0,
  };

  // Explorer signals: high question density, deep conversations, variable engagement
  if (fingerprint.avgQuestionDensity > 0.5) scores.explorer += 2;
  else if (fingerprint.avgQuestionDensity > 0.3) scores.explorer += 1;
  if (fingerprint.avgConversationDepth > 12) scores.explorer += 2;
  else if (fingerprint.avgConversationDepth > 8) scores.explorer += 1;
  if (fingerprint.depthDistribution.deep > fingerprint.depthDistribution.short) {
    scores.explorer += 1;
  }

  // Director signals: short messages, low question density, many conversations
  if (fingerprint.avgUserMessageLength < 150) scores.director += 2;
  else if (fingerprint.avgUserMessageLength < 300) scores.director += 1;
  if (fingerprint.avgQuestionDensity < 0.25) scores.director += 1;
  if (fingerprint.depthDistribution.short > fingerprint.depthDistribution.deep) {
    scores.director += 2;
  }
  if (fingerprint.totalConversations > 15) scores.director += 1;

  // Thinker signals: self-corrections, deep conversations, fewer conversations
  if (fingerprint.metacognitionIndex > 2) scores.thinker += 3;
  else if (fingerprint.metacognitionIndex > 1) scores.thinker += 2;
  else if (fingerprint.metacognitionIndex > 0.5) scores.thinker += 1;
  if (fingerprint.depthDistribution.deep > 3) scores.thinker += 1;
  if (fingerprint.totalConversations < 10) scores.thinker += 1;

  // Synthesizer signals: multiple platforms, varied conversation depths
  const platformCount = Object.keys(fingerprint.platformDistribution).length;
  if (platformCount >= 3) scores.synthesizer += 2;
  else if (platformCount >= 2) scores.synthesizer += 1;
  // Balanced depth distribution = synthesizer
  const { short, medium, deep } = fingerprint.depthDistribution;
  const maxDepth = Math.max(short, medium, deep);
  const minDepth = Math.min(short, medium, deep);
  if (maxDepth > 0 && (maxDepth - minDepth) / maxDepth < 0.5) {
    scores.synthesizer += 2;
  }
  if (fingerprint.avgUserMessageLength > 400) scores.synthesizer += 1;

  // Find dominant style
  const entries = Object.entries(scores) as [InteractionStyle, number][];
  entries.sort(([, a], [, b]) => b - a);
  const [style, topScore] = entries[0];
  const totalScore = entries.reduce((sum, [, s]) => sum + s, 0);
  const confidence = totalScore > 0 ? topScore / totalScore : 0;

  // Generate OIE-formatted observation
  const oie = generateStyleOIE(style, fingerprint);

  return {
    style,
    confidence: Math.round(confidence * 100) / 100,
    ...oie,
  };
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Compute average time between consecutive user messages.
 * Uses the `timestamp` field if available.
 */
function computeResponseCadence(userMessages: MessageData[]): number | null {
  if (userMessages.length < 2) return null;

  const timestamped = userMessages
    .filter(m => m.timestamp)
    .sort((a, b) => new Date(a.timestamp!).getTime() - new Date(b.timestamp!).getTime());

  if (timestamped.length < 2) return null;

  let totalDelta = 0;
  let count = 0;

  for (let i = 1; i < timestamped.length; i++) {
    const delta = new Date(timestamped[i].timestamp!).getTime() -
                  new Date(timestamped[i - 1].timestamp!).getTime();
    // Skip unreasonably large gaps (> 1 hour — likely a break, not response cadence)
    if (delta > 0 && delta < 3600_000) {
      totalDelta += delta;
      count++;
    }
  }

  return count > 0 ? Math.round(totalDelta / count / 1000) : null;
}

/**
 * Count self-correction/metacognition markers in user messages.
 */
function countSelfCorrections(userMessages: MessageData[]): number {
  let count = 0;
  for (const msg of userMessages) {
    for (const pattern of SELF_CORRECTION_PATTERNS) {
      if (pattern.test(msg.content)) {
        count++;
        break; // Count max one correction per message
      }
    }
  }
  return count;
}

/**
 * Classify the engagement arc based on message length progression.
 *
 * - deepening: messages generally getting longer (more engaged)
 * - plateauing: messages roughly stable length
 * - disengaging: messages getting shorter
 * - variable: no clear pattern
 */
function classifyEngagementArc(
  lengths: number[],
): 'deepening' | 'plateauing' | 'disengaging' | 'variable' {
  if (lengths.length < 3) return 'variable';

  // Split into first half and second half
  const midpoint = Math.floor(lengths.length / 2);
  const firstHalf = lengths.slice(0, midpoint);
  const secondHalf = lengths.slice(midpoint);

  const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

  if (firstAvg === 0 && secondAvg === 0) return 'plateauing';

  const ratio = firstAvg > 0 ? secondAvg / firstAvg : secondAvg > 0 ? 2 : 1;

  if (ratio > 1.3) return 'deepening';
  if (ratio < 0.7) return 'disengaging';

  // Check variance — if it's high, it's variable, otherwise plateauing
  const allAvg = lengths.reduce((s, v) => s + v, 0) / lengths.length;
  const variance = lengths.reduce((s, v) => s + (v - allAvg) ** 2, 0) / lengths.length;
  const cv = allAvg > 0 ? Math.sqrt(variance) / allAvg : 0; // coefficient of variation

  return cv > 0.8 ? 'variable' : 'plateauing';
}

/**
 * Estimate platform switches per day.
 * A "switch" is when consecutive conversations (by timestamp) are on different platforms.
 */
function computePlatformSwitchesPerDay(conversations: ConversationData[]): number {
  if (conversations.length < 2) return 0;

  // Sort by start time
  const sorted = [...conversations].sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
  );

  // Count switches
  let switches = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].platform !== sorted[i - 1].platform) {
      switches++;
    }
  }

  // Estimate days in the period
  const firstDay = new Date(sorted[0].started_at).getTime();
  const lastDay = new Date(sorted[sorted.length - 1].started_at).getTime();
  const daySpan = Math.max(1, (lastDay - firstDay) / (1000 * 60 * 60 * 24));

  return switches / daySpan;
}

/**
 * Generate OIE-formatted text for an interaction style.
 */
function generateStyleOIE(
  style: InteractionStyle,
  fingerprint: WeeklyCommunicationFingerprint,
): { observation: string; implication: string; experiment: string } {
  const qPct = Math.round(fingerprint.avgQuestionDensity * 100);
  const depth = fingerprint.avgConversationDepth;
  const mc = fingerprint.metacognitionIndex;
  const platforms = Object.keys(fingerprint.platformDistribution).length;
  const avgLen = fingerprint.avgUserMessageLength;

  switch (style) {
    case 'explorer':
      return {
        observation: `You asked questions in ${qPct}% of your messages this week, with an average conversation depth of ${depth} messages.`,
        implication: `This might indicate a research-oriented or discovery phase, where you're using AI conversations to explore ideas and test hypotheses.`,
        experiment: `If curious, you could try one conversation this week in a more directive mode — give the AI a specific task rather than asking questions — and notice how it changes the output.`,
      };

    case 'director':
      return {
        observation: `Your messages averaged ${avgLen} characters this week across ${fingerprint.totalConversations} conversations, with ${qPct}% containing questions.`,
        implication: `This could suggest a task-execution focus, where you're efficiently using AI as a tool to get specific things done.`,
        experiment: `You might consider trying a longer exploratory conversation on one topic you're curious about — sometimes the best insights emerge when you wander.`,
      };

    case 'thinker':
      return {
        observation: `You self-corrected or revised your thinking ${mc.toFixed(1)} times per conversation this week, with most conversations going ${depth}+ messages deep.`,
        implication: `This might reflect a deliberative thinking style where you're using AI as a sounding board to refine and challenge your own ideas.`,
        experiment: `If you're enjoying this mode, you could try explicitly asking the AI to challenge your assumptions — it might accelerate the refinement you're already doing naturally.`,
      };

    case 'synthesizer':
      return {
        observation: `You used ${platforms} different AI platforms this week with a balanced mix of short and deep conversations, averaging ${avgLen} characters per message.`,
        implication: `This could indicate a pattern of cross-pollinating ideas across tools and contexts, which might suggest integrative thinking.`,
        experiment: `You could try starting a "synthesis conversation" where you explicitly ask AI to connect themes from your recent conversations — it might surface connections you haven't noticed.`,
      };
  }
}

// ============================================================
// Feature 4: Kairos Fluency Score (0-100)
// ============================================================

/**
 * Compute the Kairos Fluency Score: a composite 0-100 metric
 * from 4 dimensions × 25 points each.
 *
 * Returns null if fewer than 3 conversations (insufficient data).
 */
export function computeFluencyScore(
  fingerprint: WeeklyCommunicationFingerprint,
  profiles: ConversationEngagementProfile[],
  conversations: ConversationData[],
): KairosFluencyScore | null {
  if (conversations.length < 3) return null;

  const delegation = scoreDelegation(conversations);
  const iteration = scoreIteration(profiles, conversations);
  const discernment = scoreDiscernment(fingerprint, conversations);
  const breadth = scoreBreadth(fingerprint);

  const total = Math.round(delegation + iteration + discernment + breadth);

  const label: KairosFluencyScore['label'] =
    total <= 25 ? 'emerging' :
    total <= 50 ? 'developing' :
    total <= 75 ? 'proficient' : 'fluent';

  const score: KairosFluencyScore = {
    total, delegation: round2(delegation), iteration: round2(iteration),
    discernment: round2(discernment), breadth: round2(breadth), label,
    observation: '', implication: '', experiment: '',
  };

  const oie = generateFluencyOIE(score);
  score.observation = oie.observation;
  score.implication = oie.implication;
  score.experiment = oie.experiment;

  return score;
}

/** Round to 1 decimal place */
function round2(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---- Delegation Quality (0-25) ----

function scoreDelegation(conversations: ConversationData[]): number {
  let totalSpecificity = 0;
  let totalFormat = 0;
  let totalContext = 0;
  let totalConstraint = 0;
  let msgCount = 0;

  for (const conv of conversations) {
    const userMsgs = conv.messages.filter(m => m.role === 'user');
    for (const msg of userMsgs) {
      const content = msg.content;
      msgCount++;

      // Specificity: how many specificity patterns match (cap at 1)
      const specHits = DELEGATION_PATTERNS.specificity.filter(p => p.test(content)).length;
      totalSpecificity += Math.min(1, specHits / 2);

      // Format request
      const hasFormat = DELEGATION_PATTERNS.formatRequest.some(p => p.test(content));
      totalFormat += hasFormat ? 1 : 0;

      // Context provision: needs both length and framing language
      const hasContext = DELEGATION_PATTERNS.contextProvision.some(p => p.test(content));
      if (content.length > 200 && hasContext) totalContext += 1;
      else if (content.length > 100) totalContext += 0.5;

      // Constraint setting
      const constraintHits = DELEGATION_PATTERNS.constraintSetting.filter(p => p.test(content)).length;
      totalConstraint += Math.min(1, constraintHits / 2);
    }
  }

  if (msgCount === 0) return 0;

  const avgSpecificity = totalSpecificity / msgCount;
  const avgFormat = totalFormat / msgCount;
  const avgContext = totalContext / msgCount;
  const avgConstraint = totalConstraint / msgCount;

  // Weighted combination scaled to 0-25
  return (avgSpecificity * 0.3 + avgFormat * 0.2 + avgContext * 0.3 + avgConstraint * 0.2) * 25;
}

// ---- Iteration Depth (0-25) ----

function scoreIteration(
  profiles: ConversationEngagementProfile[],
  conversations: ConversationData[],
): number {
  if (conversations.length === 0) return 0;

  // Building pattern score: proportion of conversations with iteration language
  let convsWithBuilding = 0;
  for (const conv of conversations) {
    if (conv.messages.length < 3) continue; // Skip very short convs
    const userMsgs = conv.messages.filter(m => m.role === 'user');
    const hasBuilding = userMsgs.some(msg =>
      ITERATION_PATTERNS.some(p => p.test(msg.content))
    );
    if (hasBuilding) convsWithBuilding++;
  }
  const eligibleConvs = conversations.filter(c => c.messages.length >= 3).length;
  const buildingScore = eligibleConvs > 0 ? convsWithBuilding / eligibleConvs : 0;

  // Depth score: normalized average conversation depth
  const avgDepth = conversations.reduce((sum, c) => sum + c.message_count, 0) / conversations.length;
  const depthScore = avgDepth >= 30 ? 1.0 : avgDepth >= 20 ? 0.8 : avgDepth >= 10 ? 0.5 : avgDepth >= 5 ? 0.2 : 0.1;

  // Engagement arc score: weighted average
  const arcValues: Record<string, number> = { deepening: 1.0, plateauing: 0.6, variable: 0.4, disengaging: 0.2 };
  const arcScore = profiles.length > 0
    ? profiles.reduce((sum, p) => sum + (arcValues[p.engagementArc] || 0.4), 0) / profiles.length
    : 0.4;

  return (buildingScore * 0.35 + depthScore * 0.3 + arcScore * 0.35) * 25;
}

// ---- Discernment (0-25) ----

function scoreDiscernment(
  fingerprint: WeeklyCommunicationFingerprint,
  conversations: ConversationData[],
): number {
  // Question density (from existing fingerprint)
  const questionScore = Math.min(1, fingerprint.avgQuestionDensity / 0.6);

  // Self-correction (from existing fingerprint)
  const selfCorrectionScore = Math.min(1, fingerprint.metacognitionIndex / 3);

  // Pushback patterns: proportion of user messages with pushback
  let pushbackMsgs = 0;
  let verificationMsgs = 0;
  let totalUserMsgs = 0;

  for (const conv of conversations) {
    const userMsgs = conv.messages.filter(m => m.role === 'user');
    for (const msg of userMsgs) {
      totalUserMsgs++;
      if (DISCERNMENT_PATTERNS.pushback.some(p => p.test(msg.content))) pushbackMsgs++;
      if (DISCERNMENT_PATTERNS.verification.some(p => p.test(msg.content))) verificationMsgs++;
    }
  }

  const pushbackScore = totalUserMsgs > 0 ? Math.min(1, (pushbackMsgs / totalUserMsgs) / 0.15) : 0;
  const verificationScore = totalUserMsgs > 0 ? Math.min(1, (verificationMsgs / totalUserMsgs) / 0.1) : 0;

  return (questionScore * 0.25 + pushbackScore * 0.35 + selfCorrectionScore * 0.25 + verificationScore * 0.15) * 25;
}

// ---- Cross-Platform Breadth (0-25) ----

function scoreBreadth(fingerprint: WeeklyCommunicationFingerprint): number {
  const platformCount = Object.keys(fingerprint.platformDistribution).length;

  // Diversity score
  const diversityScore = platformCount >= 4 ? 1.0 : platformCount >= 3 ? 0.9 : platformCount >= 2 ? 0.6 : 0.2;

  // Balance score: Shannon entropy normalized by max entropy
  let balanceScore = 0;
  if (platformCount >= 2) {
    const total = Object.values(fingerprint.platformDistribution).reduce((s, v) => s + v, 0);
    let entropy = 0;
    for (const count of Object.values(fingerprint.platformDistribution)) {
      const p = count / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(platformCount);
    balanceScore = maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  // Switch score (from existing fingerprint)
  const switchScore = Math.min(1, fingerprint.platformSwitchesPerDay / 2);

  return (diversityScore * 0.4 + balanceScore * 0.3 + switchScore * 0.3) * 25;
}

// ---- Fluency OIE Generation ----

function generateFluencyOIE(
  score: KairosFluencyScore,
): { observation: string; implication: string; experiment: string } {
  const dims = [
    { name: 'Delegation', val: score.delegation },
    { name: 'Iteration', val: score.iteration },
    { name: 'Discernment', val: score.discernment },
    { name: 'Breadth', val: score.breadth },
  ];
  const strongest = dims.reduce((a, b) => b.val > a.val ? b : a);
  const weakest = dims.reduce((a, b) => b.val < a.val ? b : a);

  const observation = `Your Kairos Fluency Score is ${score.total} this week. Your strongest dimension is ${strongest.name} (${strongest.val}/25).`;

  let implication: string;
  let experiment: string;

  if (score.total <= 25) {
    implication = `This suggests you're in the early stages of developing your AI communication patterns. There's plenty of room to explore different interaction styles.`;
    experiment = `You could try being more specific in one conversation this week — add constraints, request a specific format, or provide more context — and notice if the output improves.`;
  } else if (score.total <= 50) {
    implication = `Your ${weakest.name} score (${weakest.val}/25) might indicate an area where small changes could have a noticeable impact on your AI interactions.`;
    experiment = weakest.name === 'Delegation'
      ? `Try adding word limits or format requests to your next prompt and see how it changes the response.`
      : weakest.name === 'Iteration'
      ? `In your next conversation, try building on the AI's response rather than starting a new topic — notice how the depth changes.`
      : weakest.name === 'Discernment'
      ? `After your next AI response, try asking "What's wrong with this?" or "What am I missing?" — it often surfaces important caveats.`
      : `If you have access to multiple AI tools, try using a different one for your next task and compare the results.`;
  } else if (score.total <= 75) {
    implication = `Your overall pattern suggests proficient AI communication, with particular strength in ${strongest.name}.`;
    experiment = `You might experiment with deliberately changing your style for one conversation — if you're usually precise, try being more exploratory, or vice versa.`;
  } else {
    implication = `Your interaction patterns suggest fluent AI communication across multiple dimensions. You might benefit from reflecting on what makes your approach effective.`;
    experiment = `Consider sharing your approach with others or trying to articulate what you've learned about effective AI interaction — teaching often deepens understanding.`;
  }

  return { observation, implication, experiment };
}

// ============================================================
// Feature 5: Relationship Health Signals
// ============================================================

/**
 * Compute relationship health signals for a set of conversations.
 * Each signal can be null if there's insufficient data.
 */
export function computeRelationshipHealth(
  conversations: ConversationData[],
): RelationshipHealthSignals {
  const anthro = computeAnthropomorphization(conversations);
  const sovereignty = computeCognitiveSovereignty(conversations);
  const artifact = computeArtifactDiscernment(conversations);

  return {
    anthropomorphizationIndex: anthro,
    cognitiveSovereigntyScore: sovereignty,
    artifactDiscernment: artifact,
    anthropomorphizationOIE: anthro !== null ? generateAnthroOIE(anthro) : null,
    sovereigntyOIE: sovereignty !== null ? generateSovereigntyOIE(sovereignty) : null,
    discernmentOIE: artifact !== null ? generateArtifactOIE(artifact) : null,
  };
}

// ---- Anthropomorphization Index (0-1) ----

function computeAnthropomorphization(conversations: ConversationData[]): number | null {
  let totalRelationship = 0;
  let totalTool = 0;

  for (const conv of conversations) {
    const userMsgs = conv.messages.filter(m => m.role === 'user');
    for (const msg of userMsgs) {
      for (const p of ANTHROPOMORPHIZATION_PATTERNS.relationship) {
        if (p.test(msg.content)) totalRelationship++;
      }
      for (const p of ANTHROPOMORPHIZATION_PATTERNS.tool) {
        if (p.test(msg.content)) totalTool++;
      }
    }
  }

  const total = totalRelationship + totalTool;
  if (total < 5) return null; // Not enough signal
  return Math.round((totalRelationship / total) * 100) / 100;
}

// ---- Cognitive Sovereignty Score (0-1) ----

function computeCognitiveSovereignty(conversations: ConversationData[]): number | null {
  let sovereigntyHits = 0;
  let outsourcingHits = 0;
  let passiveAcceptances = 0;
  let totalAiResponses = 0;

  for (const conv of conversations) {
    const msgs = conv.messages;
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.role === 'user') {
        for (const p of SOVEREIGNTY_PATTERNS.sovereignty) {
          if (p.test(msg.content)) { sovereigntyHits++; break; }
        }
        for (const p of SOVEREIGNTY_PATTERNS.outsourcing) {
          if (p.test(msg.content)) { outsourcingHits++; break; }
        }
      }

      // Detect passive acceptance: after an AI message, user responds
      // with a short message, no questions, no disagreement
      if (msg.role === 'assistant' && i + 1 < msgs.length && msgs[i + 1].role === 'user') {
        totalAiResponses++;
        const nextUser = msgs[i + 1].content;
        const isShort = nextUser.length < 100;
        const hasQuestion = nextUser.includes('?');
        const hasDisagreement = DISCERNMENT_PATTERNS.pushback.some(p => p.test(nextUser));
        if (isShort && !hasQuestion && !hasDisagreement) {
          passiveAcceptances++;
        }
      }
    }
  }

  const totalHits = sovereigntyHits + outsourcingHits;
  if (totalHits < 3) return null; // Not enough signal

  let baseRatio = sovereigntyHits / totalHits;

  // Penalty for passive acceptance
  if (totalAiResponses > 0) {
    const passiveRate = passiveAcceptances / totalAiResponses;
    baseRatio = Math.max(0, baseRatio - 0.1 * passiveRate);
  }

  return Math.round(Math.min(1, Math.max(0, baseRatio)) * 100) / 100;
}

// ---- Artifact Discernment (0-1) ----

function isArtifactResponse(content: string): boolean {
  if (content.length < 500) return false;
  const hits = ARTIFACT_INDICATORS.filter(p => p.test(content)).length;
  return hits >= 2;
}

function computeArtifactDiscernment(conversations: ConversationData[]): number | null {
  let totalPreQuestionRate = 0;
  let totalPostQuestionRate = 0;
  let eligibleConvs = 0;

  for (const conv of conversations) {
    const msgs = conv.messages;

    // Find first artifact moment (assistant response that qualifies)
    let artifactIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'assistant' && isArtifactResponse(msgs[i].content)) {
        artifactIdx = i;
        break;
      }
    }

    if (artifactIdx === -1) continue; // No artifacts in this conversation

    // Count user messages and questions before the artifact
    const userMsgsBefore = msgs.slice(0, artifactIdx).filter(m => m.role === 'user');
    const questionsBefore = userMsgsBefore.filter(m => m.content.includes('?')).length;

    // Count user messages and questions after the artifact
    const userMsgsAfter = msgs.slice(artifactIdx + 1).filter(m => m.role === 'user');
    const questionsAfter = userMsgsAfter.filter(m => m.content.includes('?')).length;

    // Need at least 2 user messages on each side for meaningful comparison
    if (userMsgsBefore.length < 2 || userMsgsAfter.length < 2) continue;

    const preRate = questionsBefore / userMsgsBefore.length;
    const postRate = questionsAfter / userMsgsAfter.length;

    totalPreQuestionRate += preRate;
    totalPostQuestionRate += postRate;
    eligibleConvs++;
  }

  if (eligibleConvs === 0) return null;

  const avgPreRate = totalPreQuestionRate / eligibleConvs;
  const avgPostRate = totalPostQuestionRate / eligibleConvs;

  // Discernment = post/pre ratio, capped at 1.0
  // If pre rate is 0, user never asked questions, so we can't measure change
  if (avgPreRate === 0) return null;

  return Math.round(Math.min(1, avgPostRate / avgPreRate) * 100) / 100;
}

// ---- Relationship Health OIE Generation ----

function generateAnthroOIE(
  index: number,
): { observation: string; implication: string; experiment: string } {
  const pct = Math.round(index * 100);

  if (index > 0.7) {
    return {
      observation: `${pct}% of your AI interaction language this week used social framing — words like 'please', 'thank you', 'what do you think'.`,
      implication: `This could indicate you're engaging with AI as a collaborative partner, which research suggests can improve output quality for creative tasks.`,
      experiment: `You might experiment with one purely instrumental conversation — giving direct commands without social framing — and compare the results.`,
    };
  } else if (index < 0.3) {
    return {
      observation: `Your interactions primarily use technical and tool-oriented language, with ${pct}% social framing.`,
      implication: `This instrumental framing tends to produce precise, focused outputs.`,
      experiment: `For one conversation this week, you could try adding collaborative framing ('what do you think about...', 'help me explore...') and notice if it changes the AI's response style.`,
    };
  }
  return {
    observation: `Your AI interactions show a balanced mix of social and instrumental language (${pct}% social framing).`,
    implication: `This balance suggests you're adapting your communication style to different contexts, which could indicate flexible AI interaction skills.`,
    experiment: `You might notice which framing style you naturally use for different types of tasks — creative work vs. technical tasks — and whether the pattern serves you well.`,
  };
}

function generateSovereigntyOIE(
  score: number,
): { observation: string; implication: string; experiment: string } {
  const pct = Math.round(score * 100);

  if (score > 0.7) {
    return {
      observation: `You expressed independent opinions or evaluations in most conversations this week (sovereignty score: ${pct}%).`,
      implication: `This suggests you're using AI as a thinking tool rather than a decision-maker.`,
      experiment: `This balance seems effective — you could continue exploring where AI input adds most value to your own reasoning.`,
    };
  } else if (score < 0.3) {
    return {
      observation: `Most of your conversations this week asked the AI for direct recommendations or decisions (sovereignty score: ${pct}%).`,
      implication: `This might indicate an efficiency-focused approach, or it could suggest opportunities to bring more of your own evaluation into the conversation.`,
      experiment: `You might try framing one request as 'here's what I'm thinking — poke holes in it' instead of 'what should I do'.`,
    };
  }
  return {
    observation: `Your conversations show a balanced mix of independent reasoning and AI-assisted decision-making (sovereignty score: ${pct}%).`,
    implication: `This pattern suggests you're using AI as an input to your own thinking rather than a replacement for it.`,
    experiment: `You could pay attention to which decisions you delegate to AI vs. which you keep for yourself — the pattern might reveal something about where you trust your own judgment.`,
  };
}

function generateArtifactOIE(
  score: number,
): { observation: string; implication: string; experiment: string } {
  const pct = Math.round(score * 100);

  if (score > 0.7) {
    return {
      observation: `You maintained a consistent questioning rate even after receiving detailed, formatted responses (discernment: ${pct}%).`,
      implication: `This suggests you're evaluating AI output on substance rather than presentation.`,
      experiment: `This is a strong signal of critical engagement — research shows most users reduce questioning when output looks polished.`,
    };
  } else if (score < 0.3) {
    return {
      observation: `Your questioning rate dropped significantly after receiving long, formatted AI responses (discernment: ${pct}%).`,
      implication: `This is a common pattern — research found that polished outputs reduce critical evaluation across most users.`,
      experiment: `You might try a simple experiment: after receiving a detailed AI response, ask 'What's wrong with this?' or 'What am I missing?' and see what surfaces.`,
    };
  }
  return {
    observation: `Your questioning rate shows moderate change after receiving formatted AI responses (discernment: ${pct}%).`,
    implication: `You partially maintain critical evaluation when faced with polished output, which puts you ahead of most AI users.`,
    experiment: `To strengthen this further, you could occasionally ask the AI to present its answer in plain text first, before formatting — notice if you evaluate it differently.`,
  };
}
