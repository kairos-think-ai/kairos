import type { ForceConfig } from './types';

// ── Force Defaults ───────────────────────────────────────────────────

export const DEFAULT_FORCE_CONFIG: ForceConfig = {
  centerStrength: 0.05,
  chargeStrength: -120,
  chargeDistanceMax: 300,
  linkDistance: 80,
  linkStrengthMultiplier: 1,
  collisionPadding: 4,
  clusterStrength: 0.3,
  alphaDecay: 0.02,
};

// ── Node Sizing ──────────────────────────────────────────────────────

export const NODE_RADIUS_MIN = 6;
export const NODE_RADIUS_MAX = 24;

export function importanceToRadius(importance: number): number {
  return Math.max(NODE_RADIUS_MIN, Math.min(NODE_RADIUS_MAX, importance * 30));
}

// ── Zoom Bounds ──────────────────────────────────────────────────────

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3.0;
export const ZOOM_SENSITIVITY = 0.002;

// ── Interaction Thresholds ───────────────────────────────────────────

export const CLICK_DISTANCE_THRESHOLD = 3; // px — drag vs click

// ── Theme Colors (Observatory Dark) ──────────────────────────────────

export const THEME = {
  bgPrimary: '#0A0A0F',
  bgSecondary: '#16161D',
  textPrimary: '#F0F0F5',
  textSecondary: '#8888A0',
  textMuted: '#555568',
  accent: '#6366F1',
  borderSubtle: '#222230',
} as const;

// ── Render Constants ─────────────────────────────────────────────────

export const EDGE_OPACITY_BASE = 0.03;
export const EDGE_OPACITY_STRENGTH_MULT = 0.12;
export const EDGE_WIDTH_BASE = 0.5;
export const EDGE_WIDTH_STRENGTH_MULT = 2;

export const NODE_GLOW_BLUR = 20;
export const SELECTED_RING_OFFSET = 3;
export const SELECTED_RING_WIDTH = 2;
export const HOVER_RING_OFFSET = 2;

export const LABEL_SHOW_THRESHOLD = 10; // radius * zoom must exceed this
export const LABEL_FONT_SIZE = 11;
export const LABEL_PADDING_X = 6;
export const LABEL_PADDING_Y = 3;

export const DIM_OPACITY_UNCONNECTED = 0.3;
export const DIM_OPACITY_SEARCH_MISS = 0.15;
