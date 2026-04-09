/**
 * @kairos/core — Shared engine for Kairos.
 *
 * Pure computation modules with no database or API dependencies.
 * Used by packages/mcp, packages/web, and future packages (CLI, worker).
 */

// Embedding math (cosine similarity, centroid, distance)
export {
  cosineSimilarity,
  centroid,
  cosineDistance,
  type MessageEmbedding,
} from "./embeddings.js";

// Statistical analysis (drift curves, change points, entropy, cognitive load)
export {
  computeDriftCurve,
  hdbscanCluster,
  detectChangePoints,
  computeEntropy,
  entropyTimeSeries,
  computeCognitiveLoad,
  computeConversationStats,
  type ConversationStats,
} from "./stats.js";

// Graph algorithms (PPR, connection strength, decay)
export {
  personalizedPageRank,
  computeConnectionStrength,
  temporalProximity,
  entityOverlapNoisyOR,
  decayedStrength,
  reinforcedStrength,
} from "./graph.js";

// Turn-level engagement classification (adapted from CUPS + FastChat llm_judge)
export {
  structuralClassify,
  buildEngagementPrompt,
  extractStateFromLLMOutput,
  computeEngagementProfile,
  computeUniversalMetrics,
  type EngagementState,
  type TurnClassification,
  type ConversationEngagementProfile,
  type UniversalMetrics,
} from "./engagement.js";

// Live coaching analysis (drift detection, baseline comparison, guidance generation)
export {
  detectDriftFromText,
  compareToBaseline,
  generateCoachingGuidance,
  classifyLiveMessages,
  type Message as CoachMessage,
  type DriftSignal,
  type BaselineComparison,
  type CoachingOutput,
  type StoredBaseline,
} from "./coaching.js";

// Configuration (central constants registry)
export {
  getConfig,
  loadConfig,
  resetConfig,
  DEFAULTS,
  type KairosConfig,
  type StatsConfig,
  type GraphConfig,
  type CoachingConfig,
  type BehavioralConfig,
} from "./config.js";

// Re-export prompts for consumers that need them
export * from "./prompts/skills.js";
