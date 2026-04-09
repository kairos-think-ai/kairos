/**
 * Re-export stats from @kairos/core.
 * MCP tools import from here for backwards compatibility.
 */
export {
  computeDriftCurve,
  computeDriftCurve as computeDriftScore, // backward compat alias
  hdbscanCluster,
  detectChangePoints,
  computeEntropy,
  entropyTimeSeries,
  computeCognitiveLoad,
  computeConversationStats,
  type ConversationStats,
} from "@kairos/core";
