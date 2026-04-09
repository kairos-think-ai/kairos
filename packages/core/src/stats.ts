/**
 * Statistical analysis module for Kairos.
 *
 * Math layer — deterministic, reproducible metrics computed from message embeddings.
 * These provide the consistent baseline that the LLM layer interprets.
 *
 * Algorithms (SOTA-validated 2026-04-01):
 *   - Centroid drift curve (replaces JSD — no clustering dependency, produces time series)
 *   - HDBSCAN for topic clustering (replaces k-means — auto-determines k, handles noise)
 *   - TextTiling for change point detection (embedding-adapted, Hearst 1997 + modern embeddings)
 *   - Shannon entropy for discovery/production mode
 *   - Cognitive Load Index (composite, weights to be PCA-validated at 100+ conversations)
 */

import { cosineSimilarity, centroid, cosineDistance, type MessageEmbedding } from "./embeddings.js";
import { getConfig } from "./config.js";

// ── Centroid Drift Curve ──────────────────────────────────────────────

/**
 * Compute the embedding centroid drift curve for a conversation.
 *
 * For each message i, computes the running centroid of messages 1..i,
 * then measures the cosine distance of message i+1 from that centroid.
 * This yields a time series showing how the conversation moves away
 * from its starting point.
 *
 * No clustering dependency. Richer output than a single JSD number.
 *
 * Returns:
 *   - driftCurve: cosine distance from running centroid at each point
 *   - totalDrift: final distance from origin centroid (how far you ended up)
 *   - maxDrift: peak distance during conversation
 *   - driftVolatility: std dev of the curve (how erratic the drift was)
 *   - returnToOrigin: did the conversation come back? (final distance / max distance)
 */
export function computeDriftCurve(messages: MessageEmbedding[]): {
  driftCurve: number[];
  totalDrift: number;
  maxDrift: number;
  driftVolatility: number;
  returnToOrigin: number;
  driftScore: number; // backward-compat: single 0-1 summary
} {
  if (messages.length < 3) {
    return { driftCurve: [], totalDrift: 0, maxDrift: 0, driftVolatility: 0, returnToOrigin: 1, driftScore: 0 };
  }

  const embeddings = messages.map((m) => m.embedding);
  const curve: number[] = [];

  // Running centroid and drift measurement
  let runningSum = [...embeddings[0]];
  let count = 1;

  for (let i = 1; i < embeddings.length; i++) {
    // Centroid of messages 0..i-1
    const cent = runningSum.map((v) => v / count);

    // Distance of message i from the running centroid
    const dist = cosineDistance(embeddings[i], cent);
    curve.push(dist);

    // Update running sum (O(d) per step, no full recomputation)
    for (let d = 0; d < runningSum.length; d++) {
      runningSum[d] += embeddings[i][d];
    }
    count++;
  }

  const totalDrift = curve.length > 0 ? curve[curve.length - 1] : 0;
  const maxDrift = Math.max(...curve, 0);
  const mean = curve.reduce((a, b) => a + b, 0) / curve.length;
  const driftVolatility = Math.sqrt(
    curve.reduce((sum, v) => sum + (v - mean) ** 2, 0) / curve.length
  );
  const returnToOrigin = maxDrift > 0 ? totalDrift / maxDrift : 1;

  const cfg = getConfig();
  const driftScore = Math.min(1, totalDrift / cfg.stats.driftNormalization);

  return { driftCurve: curve, totalDrift, maxDrift, driftVolatility, returnToOrigin, driftScore };
}

// ── HDBSCAN Clustering ────────────────────────────────────────────────

/**
 * Simplified HDBSCAN for message-level topic clustering.
 *
 * Full HDBSCAN (McInnes et al., 2017) involves:
 * 1. Compute core distances
 * 2. Build mutual reachability graph
 * 3. Construct minimum spanning tree
 * 4. Build cluster hierarchy
 * 5. Extract flat clusters via EOMST stability
 *
 * For our scale (5-300 points), we use an efficient implementation
 * that skips the full MST and uses a simplified density-based approach.
 *
 * Returns cluster assignments. -1 = noise (unassigned).
 */
// EXPERIMENTAL: minClusterSize=3, minSamples=2 are defaults, not validated.
// Elbow-based cut on MST is a simplification of full HDBSCAN stability extraction.
// See KNOWN-HEURISTICS.md #4 for validation plan.
export function hdbscanCluster(
  embeddings: number[][],
  minClusterSize?: number,
  minSamples?: number
): { assignments: number[]; clusterCount: number; noiseCount: number } {
  const cfg = getConfig();
  minClusterSize = minClusterSize ?? cfg.stats.hdbscanMinClusterSize;
  minSamples = minSamples ?? cfg.stats.hdbscanMinSamples;
  const n = embeddings.length;
  if (n < minClusterSize) {
    return { assignments: new Array(n).fill(0), clusterCount: 1, noiseCount: 0 };
  }

  // Step 1: Compute pairwise cosine distance matrix
  const dist: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistance(embeddings[i], embeddings[j]);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  // Step 2: Compute core distances (distance to minSamples-th nearest neighbor)
  const coreDist = new Array(n);
  for (let i = 0; i < n; i++) {
    const sorted = dist[i].slice().sort((a, b) => a - b);
    coreDist[i] = sorted[Math.min(minSamples, n - 1)];
  }

  // Step 3: Compute mutual reachability distance
  const mrd: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.max(coreDist[i], coreDist[j], dist[i][j]);
      mrd[i][j] = d;
      mrd[j][i] = d;
    }
  }

  // Step 4: Build MST using Prim's algorithm on mutual reachability graph
  const inMST = new Array(n).fill(false);
  const mstEdges: { from: number; to: number; weight: number }[] = [];
  const minEdge = new Array(n).fill(Infinity);
  const minFrom = new Array(n).fill(-1);
  inMST[0] = true;

  for (let j = 1; j < n; j++) {
    minEdge[j] = mrd[0][j];
    minFrom[j] = 0;
  }

  for (let step = 0; step < n - 1; step++) {
    // Find minimum edge to non-MST node
    let bestNode = -1;
    let bestWeight = Infinity;
    for (let j = 0; j < n; j++) {
      if (!inMST[j] && minEdge[j] < bestWeight) {
        bestWeight = minEdge[j];
        bestNode = j;
      }
    }
    if (bestNode === -1) break;

    inMST[bestNode] = true;
    mstEdges.push({ from: minFrom[bestNode], to: bestNode, weight: bestWeight });

    // Update minimum edges
    for (let j = 0; j < n; j++) {
      if (!inMST[j] && mrd[bestNode][j] < minEdge[j]) {
        minEdge[j] = mrd[bestNode][j];
        minFrom[j] = bestNode;
      }
    }
  }

  // Step 5: Sort MST edges by weight (descending) and extract clusters
  // Cut edges above a threshold derived from the edge weight distribution
  mstEdges.sort((a, b) => a.weight - b.weight);

  // Use the "elbow" method: find where the gap between consecutive edge weights is largest
  const weights = mstEdges.map((e) => e.weight);
  let maxGap = 0;
  let cutIndex = weights.length; // default: no cut

  if (weights.length > minClusterSize) {
    for (let i = Math.floor(weights.length * 0.5); i < weights.length - 1; i++) {
      const gap = weights[i + 1] - weights[i];
      if (gap > maxGap) {
        maxGap = gap;
        cutIndex = i + 1;
      }
    }
  }

  // Step 6: Build adjacency from MST edges below cut, find connected components
  const adj: Map<number, number[]> = new Map();
  for (let i = 0; i < cutIndex && i < mstEdges.length; i++) {
    const e = mstEdges[i];
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }

  // BFS to find connected components
  const assignments = new Array(n).fill(-1);
  let clusterId = 0;

  for (let i = 0; i < n; i++) {
    if (assignments[i] !== -1) continue;
    const component: number[] = [];
    const queue = [i];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (assignments[node] !== -1) continue;
      assignments[node] = clusterId;
      component.push(node);
      for (const neighbor of adj.get(node) || []) {
        if (assignments[neighbor] === -1) queue.push(neighbor);
      }
    }

    // Mark small components as noise
    if (component.length < minClusterSize) {
      for (const node of component) assignments[node] = -1;
    } else {
      clusterId++;
    }
  }

  const noiseCount = assignments.filter((a) => a === -1).length;

  return { assignments, clusterCount: clusterId, noiseCount };
}

// ── TextTiling Change Points ──────────────────────────────────────────

/**
 * Detect topic shift points using embedding-based TextTiling.
 *
 * Computes cosine similarity between adjacent messages, then finds
 * "depth valleys" — points where similarity drops relative to neighbors.
 * A change point exists where depth > mean + k*std.
 *
 * Returns message indices where topic shifts occur.
 */
// EXPERIMENTAL: kThreshold=1.0 (1 std dev) is convention but not validated for conversation data.
// See KNOWN-HEURISTICS.md #5 for validation plan.
export function detectChangePoints(
  messages: MessageEmbedding[],
  kThreshold = 1.0
): { changePoints: number[]; similarities: number[]; depths: number[] } {
  if (messages.length < 4) {
    return { changePoints: [], similarities: [], depths: [] };
  }

  const embeddings = messages.map((m) => m.embedding);

  // Cosine similarities between adjacent messages
  const sims: number[] = [];
  for (let i = 0; i < embeddings.length - 1; i++) {
    sims.push(cosineSimilarity(embeddings[i], embeddings[i + 1]));
  }

  // Depth scores — valleys in similarity curve indicate topic boundaries
  const depths: number[] = [];
  for (let i = 1; i < sims.length - 1; i++) {
    depths.push((sims[i - 1] - sims[i]) + (sims[i + 1] - sims[i]));
  }

  if (depths.length === 0) {
    return { changePoints: [], similarities: sims, depths: [] };
  }

  const mean = depths.reduce((a, b) => a + b, 0) / depths.length;
  const std = Math.sqrt(depths.reduce((sum, d) => sum + (d - mean) ** 2, 0) / depths.length);
  const threshold = mean + kThreshold * std;

  const changePoints = depths
    .map((d, i) => ({ depth: d, index: i + 2 }))
    .filter(({ depth }) => depth > threshold)
    .map(({ index }) => index);

  return { changePoints, similarities: sims, depths };
}

// ── Information Entropy ───────────────────────────────────────────────

/**
 * Shannon entropy of a probability distribution.
 */
function shannonEntropy(p: number[]): number {
  return -p.reduce((sum, pi) => {
    if (pi <= 0) return sum;
    return sum + pi * Math.log2(pi);
  }, 0);
}

/**
 * Topic distribution from HDBSCAN cluster assignments.
 * Noise points (-1) get their own bucket.
 */
function topicDistribution(assignments: number[], clusterCount: number): number[] {
  // clusterCount clusters + 1 for noise
  const counts = new Array(clusterCount + 1).fill(0);
  for (const a of assignments) {
    if (a === -1) counts[clusterCount]++; // noise bucket
    else counts[a]++;
  }
  const total = assignments.length;
  return counts.map((c) => c / total).filter((p) => p > 0); // remove zero-probability buckets
}

/**
 * Normalized Shannon entropy of topic distribution.
 *
 * H_norm > 0.7 = discovery mode (exploring many topics)
 * H_norm < 0.3 = production mode (focused on one topic)
 * 0.3-0.7 = mixed/transitioning
 */
export function computeEntropy(messages: MessageEmbedding[]): {
  entropy: number;
  normalizedEntropy: number;
  clusterCount: number;
  noiseCount: number;
  mode: "discovery" | "production" | "mixed";
} {
  if (messages.length < 3) {
    return { entropy: 0, normalizedEntropy: 0, clusterCount: 0, noiseCount: 0, mode: "production" };
  }

  const embeddings = messages.map((m) => m.embedding);
  const { assignments, clusterCount, noiseCount } = hdbscanCluster(embeddings);
  const dist = topicDistribution(assignments, clusterCount);

  const H = shannonEntropy(dist);
  const k = dist.length;
  const Hmax = k > 1 ? Math.log2(k) : 1;
  const Hnorm = H / Hmax;

  return {
    entropy: H,
    normalizedEntropy: Hnorm,
    clusterCount,
    noiseCount,
    // EXPERIMENTAL: mode thresholds (0.7, 0.3) not yet validated against labeled data
    mode: Hnorm > getConfig().stats.entropyDiscoveryThreshold ? "discovery" : Hnorm < getConfig().stats.entropyProductionThreshold ? "production" : "mixed",
  };
}

/**
 * Sliding window entropy — detects mode transitions within a conversation.
 */
export function entropyTimeSeries(
  messages: MessageEmbedding[],
  windowSize = 8
): { position: number; entropy: number }[] {
  if (messages.length < windowSize) return [];

  const embeddings = messages.map((m) => m.embedding);
  const { assignments, clusterCount } = hdbscanCluster(embeddings);

  const Hmax = Math.log2(Math.max(2, clusterCount + 1)); // +1 for noise

  const series: { position: number; entropy: number }[] = [];
  for (let i = 0; i <= assignments.length - windowSize; i++) {
    const window = assignments.slice(i, i + windowSize);
    const dist = topicDistribution(window, clusterCount);
    const H = shannonEntropy(dist);
    series.push({ position: i + Math.floor(windowSize / 2), entropy: Hmax > 0 ? H / Hmax : 0 });
  }

  return series;
}

// ── Cognitive Load Index ──────────────────────────────────────────────

/**
 * Topic Switch Rate — fraction of adjacent messages that change topic.
 */
function topicSwitchRate(assignments: number[]): number {
  if (assignments.length < 2) return 0;
  let switches = 0;
  for (let i = 1; i < assignments.length; i++) {
    if (assignments[i] !== assignments[i - 1]) switches++;
  }
  return switches / (assignments.length - 1);
}

/**
 * Approximate lexical density using stop-word ratio.
 */
function approxLexicalDensity(text: string): number {
  const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
    "us", "them", "my", "your", "his", "its", "our", "their", "this",
    "that", "these", "those", "and", "but", "or", "nor", "not", "so",
    "if", "then", "than", "when", "where", "while", "of", "in", "to",
    "for", "with", "on", "at", "from", "by", "about", "as", "into",
    "like", "through", "after", "over", "between", "out", "up", "down",
    "just", "also", "very", "much", "more", "most", "only", "still",
    "even", "here", "there", "what", "which", "who", "how", "all",
    "each", "every", "both", "few", "some", "any", "no", "other",
  ]);

  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  const stopCount = words.filter((w) => STOP_WORDS.has(w)).length;
  return 1 - stopCount / words.length;
}

/**
 * Cognitive Load Index — composite metric.
 *
 * Components (equal weights — TODO: replace with data-driven weights
 * via PCA or factor analysis once 100+ conversations have engagement data):
 *   - Topic Switch Rate (0.20)
 *   - Lexical Density (0.20)
 *   - Question Density (0.20)
 *   - Message Length Variance (0.20)
 *   - Active topic count above working memory threshold (0.20)
 *
 * Returns 0-1 where higher = more cognitive load.
 */
export function computeCognitiveLoad(
  messageEmbeddings: MessageEmbedding[],
  rawMessages: { role: string; content: string }[]
): {
  cognitiveLoadIndex: number;
  topicSwitchRate: number;
  lexicalDensity: number;
  questionDensity: number;
  messageLengthCV: number;
  activeTopicPeak: number;
  level: "low" | "moderate" | "high" | "overloaded";
} {
  if (messageEmbeddings.length < 3) {
    return {
      cognitiveLoadIndex: 0, topicSwitchRate: 0, lexicalDensity: 0,
      questionDensity: 0, messageLengthCV: 0, activeTopicPeak: 0, level: "low",
    };
  }

  const embeddings = messageEmbeddings.map((m) => m.embedding);
  const { assignments, clusterCount } = hdbscanCluster(embeddings);

  // Component 1: Topic Switch Rate
  const tsr = topicSwitchRate(assignments);

  // Component 2: Lexical Density
  const userTexts = rawMessages.filter((m) => m.role === "user").map((m) => m.content);
  const avgLexDensity = userTexts.length > 0
    ? userTexts.reduce((sum, t) => sum + approxLexicalDensity(t), 0) / userTexts.length
    : 0.5;

  // Component 3: Question Density
  const userMessages = rawMessages.filter((m) => m.role === "user");
  const qd = userMessages.length > 0
    ? userMessages.filter((m) => m.content.includes("?")).length / userMessages.length
    : 0;

  // Component 4: Message Length CV
  const lengths = userMessages.map((m) => m.content.length);
  let mlcv = 0;
  if (lengths.length >= 2) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (mean > 0) {
      const variance = lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length;
      mlcv = Math.min(1, Math.sqrt(variance) / mean);
    }
  }

  // Component 5: Active topic count (sliding window peak)
  const windowSize = Math.min(10, Math.floor(messageEmbeddings.length / 2));
  let peakTopics = 0;
  if (windowSize >= 3) {
    for (let i = 0; i <= assignments.length - windowSize; i++) {
      const window = assignments.slice(i, i + windowSize);
      const unique = new Set(window.filter((a) => a !== -1)).size;
      if (unique > peakTopics) peakTopics = unique;
    }
  }
  // Normalize: Cowan's 4±1 working memory capacity
  const topicOverload = Math.min(1, Math.max(0, (peakTopics - 2) / 4));

  // Composite — equal weights until data-driven weights are computed via PCA
  const cli = 0.20 * tsr + 0.20 * avgLexDensity + 0.20 * qd + 0.20 * mlcv + 0.20 * topicOverload;
  // EXPERIMENTAL: thresholds not yet validated against labeled data
  const [low, mod, high] = getConfig().stats.cognitiveLoadLevels;
  const level = cli < low ? "low" : cli < mod ? "moderate" : cli < high ? "high" : "overloaded";

  return {
    cognitiveLoadIndex: cli, topicSwitchRate: tsr, lexicalDensity: avgLexDensity,
    questionDensity: qd, messageLengthCV: mlcv, activeTopicPeak: peakTopics, level,
  };
}

// ── Full Conversation Stats ───────────────────────────────────────────

export interface ConversationStats {
  drift: ReturnType<typeof computeDriftCurve>;
  changePoints: ReturnType<typeof detectChangePoints>;
  entropy: ReturnType<typeof computeEntropy>;
  cognitiveLoad: ReturnType<typeof computeCognitiveLoad>;
}

/**
 * Compute all statistical metrics for a conversation.
 * Requires message-level embeddings + raw message content.
 */
export function computeConversationStats(
  messageEmbeddings: MessageEmbedding[],
  rawMessages: { role: string; content: string }[]
): ConversationStats {
  return {
    drift: computeDriftCurve(messageEmbeddings),
    changePoints: detectChangePoints(messageEmbeddings),
    entropy: computeEntropy(messageEmbeddings),
    cognitiveLoad: computeCognitiveLoad(messageEmbeddings, rawMessages),
  };
}
