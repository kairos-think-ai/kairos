/**
 * Kairos Configuration — Central Constants Registry
 *
 * All tunable parameters in one place. Every constant that affects
 * the analysis engine is defined here with:
 *   - A typed interface
 *   - Sensible defaults (marked EXPERIMENTAL where unvalidated)
 *   - The ability to override via loadConfig()
 *
 * This enables:
 *   1. Users can adjust parameters for their use case
 *   2. Calibration scripts can output trained values
 *   3. Per-user adaptive thresholds can replace global defaults
 *   4. Every constant is discoverable and documented
 *
 * Usage:
 *   import { getConfig } from './config';
 *   const cfg = getConfig();
 *   // Use cfg.stats.hdbscanMinClusterSize instead of hardcoded 3
 */

// ── Configuration Interface ──────────────────────────────────────────

export interface KairosConfig {
  stats: StatsConfig;
  graph: GraphConfig;
  coaching: CoachingConfig;
  behavioral: BehavioralConfig;
  api: ApiConfig;
}

export interface StatsConfig {
  /** Normalization divisor for total drift score (0-1 mapping).
   *  EXPERIMENTAL: 0.5 is placeholder. Needs calibration from drift
   *  distribution across 500+ conversations. */
  driftNormalization: number;

  /** Minimum cluster size for HDBSCAN.
   *  EXPERIMENTAL: 3 is the library default. Smaller = more clusters,
   *  larger = fewer but more stable clusters. */
  hdbscanMinClusterSize: number;

  /** Minimum samples for HDBSCAN core point definition.
   *  EXPERIMENTAL: 2 is the library default. Higher = more conservative
   *  (fewer points become core points). */
  hdbscanMinSamples: number;

  /** Standard deviations above mean for TextTiling change point detection.
   *  EXPERIMENTAL: 1.0 is convention (1 std dev). Higher = fewer change
   *  points detected (more conservative). */
  textTilingKThreshold: number;

  /** Shannon entropy threshold above which a conversation is "discovery" mode.
   *  EXPERIMENTAL: 0.7 not validated against labeled data.
   *  Adaptive alternative: use user's own entropy distribution percentile. */
  entropyDiscoveryThreshold: number;

  /** Shannon entropy threshold below which a conversation is "production" mode.
   *  EXPERIMENTAL: 0.3 not validated against labeled data. */
  entropyProductionThreshold: number;

  /** Weights for the 5 components of the Cognitive Load Index.
   *  EXPERIMENTAL: equal weights (0.2 each). Should be PCA-validated
   *  at 100+ conversations to determine actual variance contribution.
   *  Components: [topicSwitchRate, lexicalDensity, questionDensity,
   *               messageLengthCV, activeTopicPeak] */
  cognitiveLoadWeights: [number, number, number, number, number];

  /** Cognitive Load Index level thresholds [low, moderate, high].
   *  EXPERIMENTAL: not validated. Values below first = low, between
   *  first and second = moderate, between second and third = high,
   *  above third = overloaded. */
  cognitiveLoadLevels: [number, number, number];
}

export interface GraphConfig {
  /** Personalized PageRank damping factor (probability of continuing walk).
   *  EXPERIMENTAL: 0.5 gives expected 2-hop walk before restart.
   *  Standard PPR uses 0.85 (longer walks). Lower = more localized results. */
  pprAlpha: number;

  /** PPR convergence iterations.
   *  20 is standard and sufficient for graphs under 10K nodes. */
  pprIterations: number;

  /** Half-life for temporal proximity decay (days).
   *  EXPERIMENTAL: 14 days. Conversations older than ~10 days get
   *  exponentially lower temporal proximity scores. */
  temporalProximityTau: number;

  /** Pheromone decay rate (exponential decay per day).
   *  EXPERIMENTAL: 0.01 per day. Higher = connections fade faster. */
  pheromoneDecayRate: number;

  /** Minimum pheromone strength (floor, never reaches zero).
   *  EXPERIMENTAL: 0.01. Prevents connections from fully disappearing. */
  pheromoneFloor: number;

  /** Reinforcement factor when connections are co-accessed.
   *  EXPERIMENTAL: 0.15. Higher = stronger reinforcement on access. */
  reinforcementFactor: number;
}

export interface CoachingConfig {
  /** Jaccard overlap threshold for "on_track" drift status.
   *  Adjusted from testing. Conversations naturally narrow from
   *  broad to specific, so this is lower than intuitive. */
  driftOnTrackThreshold: number;

  /** Jaccard overlap threshold for "drifting" status.
   *  Below this = "off_topic". */
  driftingThreshold: number;

  /** Minimum user messages before drift detection is reliable. */
  minMessagesForDrift: number;

  /** Deviation from baseline (in absolute proportion) to be "significant".
   *  0.15 = 15 percentage points. E.g., if baseline verification is 16%
   *  and current is 0%, deviation is 0.16 which exceeds 0.15. */
  baselineSignificanceThreshold: number;
}

export interface BehavioralConfig {
  /** Fluency score dimension weights.
   *  EXPERIMENTAL: all not validated.
   *  [delegation, iteration, discernment, breadth] — each scored 0-25. */
  fluencyWeights: {
    delegation: [number, number, number, number]; // [specificity, format, context, constraint]
    iteration: [number, number, number];          // [building, depth, arc]
    discernment: [number, number, number, number]; // [question, pushback, selfCorrection, verification]
    breadth: [number, number, number];             // [diversity, balance, switching]
  };

  /** Interaction style scoring thresholds.
   *  EXPERIMENTAL: heuristic thresholds for explorer/director/thinker/synthesizer. */
  styleThresholds: {
    explorerQuestionDensity: number;    // >0.5 for explorer
    directorQuestionDensity: number;    // <0.25 for director
    directorAvgMsgLength: number;       // <150 chars for director
    thinkerSelfCorrections: number;     // >2 for thinker
    synthesizerPlatformCount: number;   // 3+ for synthesizer
    synthesizerAvgMsgLength: number;    // >400 chars for synthesizer
  };

  /** Relationship health signal thresholds.
   *  EXPERIMENTAL: 0.3 cutoff for anthropomorphization/sovereignty. */
  relationshipHealthThreshold: number;
}

export interface ApiConfig {
  /** Link strength multiplier for shared conversations.
   *  EXPERIMENTAL: sharedConvos * this value, capped at 1.0.
   *  0.2 means 5 shared conversations = max strength. */
  linkStrengthMultiplier: number;

  /** Louvain community detection resolution parameter.
   *  Standard: 1.0 (Newman & Girvan 2004). Higher = more communities. */
  louvainResolution: number;
}

// ── Defaults ─────────────────────────────────────────────────────────

export const DEFAULTS: KairosConfig = {
  stats: {
    driftNormalization: 0.5,
    hdbscanMinClusterSize: 3,
    hdbscanMinSamples: 2,
    textTilingKThreshold: 1.0,
    entropyDiscoveryThreshold: 0.7,
    entropyProductionThreshold: 0.3,
    cognitiveLoadWeights: [0.2, 0.2, 0.2, 0.2, 0.2],
    cognitiveLoadLevels: [0.25, 0.45, 0.65],
  },
  graph: {
    pprAlpha: 0.5,
    pprIterations: 20,
    temporalProximityTau: 14,
    pheromoneDecayRate: 0.01,
    pheromoneFloor: 0.01,
    reinforcementFactor: 0.15,
  },
  coaching: {
    driftOnTrackThreshold: 0.12,
    driftingThreshold: 0.04,
    minMessagesForDrift: 6,
    baselineSignificanceThreshold: 0.15,
  },
  behavioral: {
    fluencyWeights: {
      delegation: [0.3, 0.2, 0.3, 0.2],
      iteration: [0.35, 0.3, 0.35],
      discernment: [0.25, 0.35, 0.25, 0.15],
      breadth: [0.4, 0.3, 0.3],
    },
    styleThresholds: {
      explorerQuestionDensity: 0.5,
      directorQuestionDensity: 0.25,
      directorAvgMsgLength: 150,
      thinkerSelfCorrections: 2,
      synthesizerPlatformCount: 3,
      synthesizerAvgMsgLength: 400,
    },
    relationshipHealthThreshold: 0.3,
  },
  api: {
    linkStrengthMultiplier: 0.2,
    louvainResolution: 1.0,
  },
};

// ── Config Loading ───────────────────────────────────────────────────

let _activeConfig: KairosConfig = DEFAULTS;

/**
 * Load configuration with optional overrides.
 * Merges overrides on top of defaults (deep merge).
 *
 * Usage:
 *   loadConfig({ stats: { hdbscanMinClusterSize: 5 } });
 *
 * Or from a JSON file (output of calibration script):
 *   loadConfig(JSON.parse(fs.readFileSync('kairos-config.json')));
 */
export function loadConfig(overrides?: DeepPartial<KairosConfig>): KairosConfig {
  if (overrides) {
    _activeConfig = deepMerge(DEFAULTS, overrides);
  }
  return _activeConfig;
}

/**
 * Get the current active configuration.
 * Returns defaults if loadConfig() was never called.
 */
export function getConfig(): KairosConfig {
  return _activeConfig;
}

/**
 * Reset configuration to defaults.
 */
export function resetConfig(): void {
  _activeConfig = DEFAULTS;
}

// ── Helpers ──────────────────────────────────────────────────────────

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  const output = { ...target };
  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key]) &&
        typeof (target as any)[key] === 'object'
      ) {
        (output as any)[key] = deepMerge((target as any)[key], source[key] as any);
      } else {
        (output as any)[key] = source[key];
      }
    }
  }
  return output;
}
