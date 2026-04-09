// ── Graph Types ──────────────────────────────────────────────────────
// Shared interfaces for simulation, rendering, and interactions.
// SimNode/SimLink extend the API shapes with d3-force position data.

/** API-level node from /api/concepts */
export interface GraphNode {
  id: string;
  name: string;
  category: string;
  importance: number;       // 0-1
  confidence?: number;      // 0-1
  documentFrequency: number;
  status?: string;
  color: string;            // hex from API
  size: number;             // API-computed size (3-15)
}

/** API-level link from /api/concepts */
export interface GraphLink {
  source: string;
  target: string;
  strength: number;         // 0-1
  sharedConversations: number;
}

/** Simulation node — d3-force mutates x, y, vx, vy in place */
export interface SimNode {
  id: string;
  name: string;
  category: string;
  importance: number;
  confidence: number;
  documentFrequency: number;
  color: string;
  radius: number;           // computed from importance (6-24px)
  // d3-force managed:
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;        // pinned x (during drag)
  fy: number | null;        // pinned y (during drag)
  // index assigned by d3:
  index?: number;
}

/** Simulation link — d3-force replaces string IDs with object refs */
export interface SimLink {
  source: SimNode | string;
  target: SimNode | string;
  strength: number;
  sharedConversations: number;
  index?: number;
}

/** Pan/zoom transform state */
export interface GraphTransform {
  x: number;   // pan offset
  y: number;
  k: number;   // zoom scale (1 = 100%)
}

/** Current interaction state (stored in useRef, not React state) */
export interface InteractionState {
  hoveredNodeId: string | null;
  selectedNodeId: string | null;
  draggedNodeId: string | null;
  transform: GraphTransform;
  isDraggingBackground: boolean;
  dragOrigin: { x: number; y: number } | null;
  mouseDownPos: { x: number; y: number } | null;
}

/** Tunable force configuration */
export interface ForceConfig {
  centerStrength: number;
  chargeStrength: number;
  chargeDistanceMax: number;
  linkDistance: number;
  linkStrengthMultiplier: number;
  collisionPadding: number;
  clusterStrength: number;
  alphaDecay: number;
}

/** Resolved theme colors for Canvas rendering (Canvas can't read CSS variables) */
export interface ThemeColors {
  bgPrimary: string;
  bgSecondary: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentIndigo: string;
  borderSubtle: string;
  fontDisplay: string;
  fontSans: string;
  fontMono: string;
}

/** Community detection result */
export interface CommunityData {
  /** Map of nodeId → communityId */
  assignments: Map<string, number>;
  /** Map of communityId → array of nodeIds */
  communities: Map<number, string[]>;
  /** Map of communityId → display color */
  colors: Map<number, string>;
  /** Map of communityId → label */
  labels: Map<number, string>;
}

/** Props for the GraphCanvas React component */
export interface GraphCanvasProps {
  nodes: GraphNode[];
  links: GraphLink[];
  selectedNodeId: string | null;
  searchQuery: string;
  minConnections?: number;       // Thought Depth filter — hide nodes with fewer connections
  minLinkStrength?: number;      // Edge weight threshold — hide weak ties
  forceConfig?: Partial<ForceConfig>;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
}
