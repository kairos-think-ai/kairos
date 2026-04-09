/**
 * Graph algorithms for Kairos conversation connection network.
 *
 * Personalized PageRank (PPR) for retrieval — from HippoRAG (NeurIPS 2024).
 * Multi-signal connection strength computation.
 * Pheromone decay model.
 *
 * All pure computation — no database dependencies.
 */

import { cosineSimilarity } from "./embeddings.js";

// ── Personalized PageRank ─────────────────────────────────────────────

/**
 * Personalized PageRank on a conversation connection graph.
 *
 * Starts from seed nodes (e.g., conversations mentioning a queried entity),
 * walks the graph with random restarts, and scores all reachable nodes by
 * association strength.
 *
 * EXPERIMENTAL: alpha=0.5 gives expected number of steps = 1/(1-alpha) = 2 before restart.
 * Not validated for our graph density. See KNOWN-HEURISTICS.md #14.
 *
 * At 50-500 nodes, converges in <1ms.
 *
 * @param adjacency - Map of nodeId → Map of (neighborId → edge weight)
 * @param teleport - Seed node weights (should sum to ~1). Nodes to start from.
 * @param alpha - Damping factor. 0.5 = 50% chance to continue walk. Default from HippoRAG.
 * @param iterations - Number of power iterations. 20 is more than enough for convergence.
 * @returns Map of nodeId → PPR score (higher = more associated with seed nodes)
 */
export function personalizedPageRank(
  adjacency: Map<string, Map<string, number>>,
  teleport: Map<string, number>,
  alpha = 0.5,
  iterations = 20
): Map<string, number> {
  // Collect all nodes
  const nodeSet = new Set<string>();
  for (const [node, neighbors] of adjacency) {
    nodeSet.add(node);
    for (const neighbor of neighbors.keys()) nodeSet.add(neighbor);
  }
  for (const node of teleport.keys()) nodeSet.add(node);

  const nodes = [...nodeSet];
  if (nodes.length === 0) return new Map();

  // Normalize teleport vector
  const teleportSum = [...teleport.values()].reduce((a, b) => a + b, 0) || 1;
  const normalizedTeleport = new Map<string, number>();
  for (const [node, weight] of teleport) {
    normalizedTeleport.set(node, weight / teleportSum);
  }

  // Initialize scores from teleport
  let scores = new Map(normalizedTeleport);

  // Precompute out-weights for each node
  const outWeight = new Map<string, number>();
  for (const [node, neighbors] of adjacency) {
    let total = 0;
    for (const w of neighbors.values()) total += w;
    outWeight.set(node, total);
  }

  // Power iteration
  for (let iter = 0; iter < iterations; iter++) {
    const newScores = new Map<string, number>();

    for (const node of nodes) {
      let walkScore = 0;

      // Sum contributions from neighbors pointing to this node
      for (const [neighbor, neighbors] of adjacency) {
        const edgeWeight = neighbors.get(node);
        if (edgeWeight !== undefined) {
          const neighborOut = outWeight.get(neighbor) || 1;
          walkScore += (scores.get(neighbor) || 0) * edgeWeight / neighborOut;
        }
      }

      const teleportScore = normalizedTeleport.get(node) || 0;
      newScores.set(node, alpha * walkScore + (1 - alpha) * teleportScore);
    }

    scores = newScores;
  }

  return scores;
}

// ── Multi-Signal Connection Strength ──────────────────────────────────

/**
 * Compute connection strength between two conversations using multiple signals.
 *
 * Replaces the arbitrary `0.3 + sharedEntities * 0.1` formula.
 *
 * Uses weighted geometric mean — if any signal is 0, the product is 0 (hard veto).
 * Minimum 2 non-zero signals required to create a connection.
 *
 * Signals:
 *   - Semantic similarity: cosine similarity of conversation embeddings
 *   - Entity overlap: noisy-OR of IDF-weighted shared entities
 *   - Temporal proximity: exponential decay of time gap
 *
 * EXPERIMENTAL: Weights are equal — to be tuned with user engagement data.
 * See KNOWN-HEURISTICS.md #6 for validation plan.
 */
export function computeConnectionStrength(signals: {
  semanticSimilarity?: number;   // cosine sim of conversation embeddings (0-1)
  entityOverlapIDF?: number;     // noisy-OR of IDF-weighted shared entities (0-1)
  temporalProximity?: number;    // exp(-daysBetween / tau) where tau=14 days (0-1)
}): { strength: number; signalCount: number } {
  const values: number[] = [];

  if (signals.semanticSimilarity !== undefined && signals.semanticSimilarity > 0) {
    values.push(signals.semanticSimilarity);
  }
  if (signals.entityOverlapIDF !== undefined && signals.entityOverlapIDF > 0) {
    values.push(signals.entityOverlapIDF);
  }
  if (signals.temporalProximity !== undefined && signals.temporalProximity > 0) {
    values.push(signals.temporalProximity);
  }

  // Minimum 2 signals required
  if (values.length < 2) {
    // Fall back to single strongest signal if available, with penalty
    if (values.length === 1) {
      return { strength: values[0] * 0.5, signalCount: 1 }; // 50% penalty for single signal
    }
    return { strength: 0, signalCount: 0 };
  }

  // Geometric mean (equal weights)
  const product = values.reduce((a, b) => a * b, 1);
  const geometricMean = Math.pow(product, 1 / values.length);

  return { strength: geometricMean, signalCount: values.length };
}

/**
 * Compute temporal proximity signal.
 * Exponential decay: conversations close in time are more connected.
 * EXPERIMENTAL: tau = 14 days (half-life ~9.7 days). Not validated against user behavior.
 * See KNOWN-HEURISTICS.md #8 for validation plan.
 */
export function temporalProximity(dateA: Date, dateB: Date, tauDays = 14): number {
  const daysBetween = Math.abs(dateA.getTime() - dateB.getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-daysBetween / tauDays);
}

/**
 * Compute entity overlap IDF signal using noisy-OR.
 * One rare shared entity > many common shared entities.
 *
 * @param sharedEntityIDFs - IDF scores for each shared entity
 *   IDF = log((N + 1) / (df + 0.5)) / log(N + 1), normalized to [0,1]
 */
export function entityOverlapNoisyOR(sharedEntityIDFs: number[]): number {
  if (sharedEntityIDFs.length === 0) return 0;
  // Noisy-OR: P(at least one relevant) = 1 - product(1 - p_i)
  const product = sharedEntityIDFs.reduce((acc, idf) => acc * (1 - idf), 1);
  return 1 - product;
}

// ── Pheromone Decay ───────────────────────────────────────────────────

/**
 * Compute decayed connection strength.
 * Used for display/retrieval — actual decay applied via DB function.
 *
 * strength * exp(-decay_rate * days_since_access)
 * Floor at 0.01 (never fully zero — can always be rediscovered)
 */
// EXPERIMENTAL: decayRate=0.01, floor=0.01, reinforcement factor=0.15 are all unvalidated.
// See KNOWN-HEURISTICS.md #7 for validation plan.
export function decayedStrength(
  strength: number,
  daysSinceAccess: number,
  decayRate = 0.01
): number {
  return Math.max(0.01, strength * Math.exp(-decayRate * daysSinceAccess));
}

/**
 * Compute reinforced connection strength (diminishing returns).
 * Called when two conversations are co-accessed.
 */
export function reinforcedStrength(
  currentStrength: number,
  accessCount: number,
  factor = 0.15
): number {
  // Diminishing returns: strong early reinforcement that tapers off
  const reinforcement = factor / (1 + 0.1 * accessCount);
  return Math.min(1.0, currentStrength + (1 - currentStrength) * reinforcement);
}
