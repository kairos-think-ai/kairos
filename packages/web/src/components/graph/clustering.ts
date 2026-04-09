/**
 * Community Detection (Louvain) + Convex Hull
 *
 * Louvain algorithm: modularity-based community detection.
 * No hardcoded thresholds — modularity optimization is self-tuning.
 * Resolution parameter (gamma) controls granularity (1.0 = standard).
 *
 * Interface is algorithm-agnostic — can swap for Leiden or
 * idea-tree-aware clustering later.
 *
 * Edge weight: uses sharedConversations (raw count) directly.
 * Modularity Q is computed using weighted adjacency.
 *
 * References:
 * - Blondel et al. (2008) "Fast unfolding of communities in large networks"
 * - Newman & Girvan (2004) modularity definition
 */

import type { CommunityData } from './types';

interface Node { id: string; category: string }
interface Link { source: string; target: string; sharedConversations: number }

// ── Louvain Community Detection ──────────────────────────────────────

/**
 * Detect communities using the Louvain algorithm.
 *
 * @param nodes - Graph nodes with id and category
 * @param links - Graph links with source, target, and sharedConversations
 * @param gamma - Resolution parameter (1.0 = standard, higher = more communities)
 * @returns CommunityData with assignments, community members, colors, and labels
 */
export function detectCommunities(
  nodes: Node[],
  links: Link[],
  gamma: number = 1.0,
): CommunityData {
  if (nodes.length === 0) {
    return { assignments: new Map(), communities: new Map(), colors: new Map(), labels: new Map() };
  }

  // Build adjacency structure
  const nodeIds = nodes.map(n => n.id);
  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const n = nodeIds.length;

  // Adjacency list with weights
  const adj: Map<number, Map<number, number>> = new Map();
  for (let i = 0; i < n; i++) adj.set(i, new Map());

  let totalWeight = 0;
  for (const link of links) {
    const i = nodeIndex.get(link.source);
    const j = nodeIndex.get(link.target);
    if (i === undefined || j === undefined) continue;
    const w = link.sharedConversations;
    adj.get(i)!.set(j, (adj.get(i)!.get(j) || 0) + w);
    adj.get(j)!.set(i, (adj.get(j)!.get(i) || 0) + w);
    totalWeight += w;
  }

  if (totalWeight === 0) {
    // No edges — each node is its own community
    const assignments = new Map<string, number>();
    nodes.forEach((node, i) => assignments.set(node.id, i));
    return buildCommunityData(assignments, nodes);
  }

  // Node strengths (weighted degree)
  const strength: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const w of adj.get(i)!.values()) {
      strength[i] += w;
    }
  }

  // Initialize: each node in its own community
  const community: number[] = Array.from({ length: n }, (_, i) => i);

  // Phase 1: Local modularity optimization
  let improved = true;
  let iterations = 0;
  const maxIterations = 50; // Safety limit

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    for (let i = 0; i < n; i++) {
      const currentCom = community[i];

      // Compute weights to each neighboring community
      const neighborComWeights = new Map<number, number>();
      for (const [j, w] of adj.get(i)!.entries()) {
        const com = community[j];
        neighborComWeights.set(com, (neighborComWeights.get(com) || 0) + w);
      }

      // Compute modularity gain for moving to each neighbor community
      let bestCom = currentCom;
      let bestGain = 0;

      // Weight of edges from i to its current community
      const kiIn = neighborComWeights.get(currentCom) || 0;
      const ki = strength[i];

      // Sum of weights in current community (excluding i)
      let sigmaCurrentTot = 0;
      for (let j = 0; j < n; j++) {
        if (j !== i && community[j] === currentCom) {
          sigmaCurrentTot += strength[j];
        }
      }

      for (const [com, kiTo] of neighborComWeights.entries()) {
        if (com === currentCom) continue;

        // Sum of weights in target community
        let sigmaTot = 0;
        for (let j = 0; j < n; j++) {
          if (community[j] === com) {
            sigmaTot += strength[j];
          }
        }

        // Modularity gain (Blondel et al. 2008, equation 1)
        const m2 = 2 * totalWeight;
        const gain = (kiTo - kiIn) / m2
          - gamma * ki * (sigmaTot - sigmaCurrentTot) / (m2 * m2);

        if (gain > bestGain) {
          bestGain = gain;
          bestCom = com;
        }
      }

      if (bestCom !== currentCom) {
        community[i] = bestCom;
        improved = true;
      }
    }
  }

  // Compact community IDs (remove gaps)
  const uniqueComs = [...new Set(community)];
  const comMap = new Map(uniqueComs.map((c, i) => [c, i]));
  const compacted = community.map(c => comMap.get(c)!);

  // Build result
  const assignments = new Map<string, number>();
  nodes.forEach((node, i) => assignments.set(node.id, compacted[i]));

  return buildCommunityData(assignments, nodes);
}

// ── Build Community Metadata ─────────────────────────────────────────

const COMMUNITY_COLORS = [
  '#6366F1', // indigo
  '#E5A54B', // gold
  '#10B981', // emerald
  '#EC4899', // pink
  '#3B82F6', // blue
  '#8B5CF6', // purple
  '#F59E0B', // amber
  '#06B6D4', // cyan
  '#EF4444', // red
  '#14B8A6', // teal
];

function buildCommunityData(
  assignments: Map<string, number>,
  nodes: Node[],
): CommunityData {
  // Group nodes by community
  const communities = new Map<number, string[]>();
  for (const [nodeId, comId] of assignments) {
    if (!communities.has(comId)) communities.set(comId, []);
    communities.get(comId)!.push(nodeId);
  }

  // Assign colors
  const colors = new Map<number, string>();
  let colorIdx = 0;
  for (const comId of communities.keys()) {
    colors.set(comId, COMMUNITY_COLORS[colorIdx % COMMUNITY_COLORS.length]);
    colorIdx++;
  }

  // Generate labels from most common category in each community
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const labels = new Map<number, string>();
  for (const [comId, memberIds] of communities) {
    if (memberIds.length === 1) {
      // Singleton — use node name directly
      const node = nodeMap.get(memberIds[0]);
      labels.set(comId, node?.category || 'Other');
    } else {
      // Count categories in this community
      const catCounts = new Map<string, number>();
      for (const id of memberIds) {
        const cat = nodeMap.get(id)?.category || 'other';
        catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
      }
      // Most common category becomes the label
      const topCat = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      labels.set(comId, formatCategoryLabel(topCat, memberIds.length));
    }
  }

  return { assignments, communities, colors, labels };
}

function formatCategoryLabel(category: string, count: number): string {
  const labels: Record<string, string> = {
    concept: 'Concepts',
    technology: 'Technology',
    tool: 'Tools',
    company: 'Companies',
    person: 'People',
    project_name: 'Projects',
    decision: 'Decisions',
    goal: 'Goals',
    other: 'Other',
  };
  return `${labels[category] || category} (${count})`;
}

// ── Convex Hull (Graham Scan) ────────────────────────────────────────

/**
 * Compute the convex hull of a set of 2D points using Graham Scan.
 * Returns points in counter-clockwise order.
 * If fewer than 3 points, returns the points as-is.
 */
export function convexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 3) return [...points];

  // Find the bottom-most point (and leftmost if tie)
  let pivot = points[0];
  for (const p of points) {
    if (p.y > pivot.y || (p.y === pivot.y && p.x < pivot.x)) {
      pivot = p;
    }
  }

  // Sort by polar angle relative to pivot
  const sorted = points
    .filter(p => p !== pivot)
    .sort((a, b) => {
      const angleA = Math.atan2(a.y - pivot.y, a.x - pivot.x);
      const angleB = Math.atan2(b.y - pivot.y, b.x - pivot.x);
      if (angleA !== angleB) return angleA - angleB;
      // Same angle — closer point first
      const distA = (a.x - pivot.x) ** 2 + (a.y - pivot.y) ** 2;
      const distB = (b.x - pivot.x) ** 2 + (b.y - pivot.y) ** 2;
      return distA - distB;
    });

  const hull = [pivot, sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    while (hull.length > 1 && cross(hull[hull.length - 2], hull[hull.length - 1], sorted[i]) <= 0) {
      hull.pop();
    }
    hull.push(sorted[i]);
  }

  return hull;
}

function cross(o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Expand a convex hull outward by a padding distance.
 * Moves each point away from the centroid by `padding` pixels.
 */
export function expandHull(
  hull: Array<{ x: number; y: number }>,
  padding: number,
): Array<{ x: number; y: number }> {
  if (hull.length < 2) return hull;

  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;

  return hull.map(p => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return p;
    return {
      x: p.x + (dx / dist) * padding,
      y: p.y + (dy / dist) * padding,
    };
  });
}
