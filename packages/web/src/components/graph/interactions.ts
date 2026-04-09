import { quadtree, type Quadtree } from 'd3-quadtree';
import type { SimNode, GraphTransform } from './types';

// ── Coordinate Transforms ────────────────────────────────────────────

export function screenToWorld(
  screenX: number,
  screenY: number,
  transform: GraphTransform,
): { x: number; y: number } {
  return {
    x: (screenX - transform.x) / transform.k,
    y: (screenY - transform.y) / transform.k,
  };
}

export function worldToScreen(
  worldX: number,
  worldY: number,
  transform: GraphTransform,
): { x: number; y: number } {
  return {
    x: worldX * transform.k + transform.x,
    y: worldY * transform.k + transform.y,
  };
}

// ── Quadtree for Spatial Queries ─────────────────────────────────────

export function buildQuadtree(nodes: SimNode[]): Quadtree<SimNode> {
  return quadtree<SimNode>()
    .x(d => d.x)
    .y(d => d.y)
    .addAll(nodes);
}

export function findNodeAtPoint(
  worldX: number,
  worldY: number,
  tree: Quadtree<SimNode>,
): SimNode | null {
  let found: SimNode | null = null;
  let bestDist = Infinity;

  tree.visit((node, x0, y0, x1, y1) => {
    // If this is a leaf with data
    if (!node.length) {
      let current = node;
      do {
        const d = current.data;
        if (d) {
          const dx = worldX - d.x;
          const dy = worldY - d.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < d.radius && dist < bestDist) {
            bestDist = dist;
            found = d;
          }
        }
        current = current.next!;
      } while (current);
    }

    // Prune: skip if the closest possible point in this quad is farther
    // than the best radius we've found so far
    const closestX = Math.max(x0, Math.min(worldX, x1));
    const closestY = Math.max(y0, Math.min(worldY, y1));
    const dx = worldX - closestX;
    const dy = worldY - closestY;
    return dx * dx + dy * dy > (found ? found.radius * found.radius : 30 * 30);
  });

  return found;
}

// ── Zoom Helpers ─────────────────────────────────────────────────────

export function zoomAtPoint(
  transform: GraphTransform,
  screenX: number,
  screenY: number,
  delta: number,
  minK: number,
  maxK: number,
): GraphTransform {
  const newK = Math.max(minK, Math.min(maxK, transform.k * (1 - delta)));

  // Adjust pan so the point under the cursor stays fixed
  const factor = newK / transform.k;
  return {
    k: newK,
    x: screenX - (screenX - transform.x) * factor,
    y: screenY - (screenY - transform.y) * factor,
  };
}

// ── Distance Helpers ─────────────────────────────────────────────────

export function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
