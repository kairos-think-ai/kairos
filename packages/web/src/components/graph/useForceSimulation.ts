import { useRef, useEffect, useCallback } from 'react';
import {
  forceSimulation,
  forceCenter,
  forceManyBody,
  forceLink,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import type { GraphNode, GraphLink, SimNode, SimLink, ForceConfig } from './types';
import { DEFAULT_FORCE_CONFIG, importanceToRadius } from './constants';

// ── Custom Category Clustering Force ─────────────────────────────────

function forceCluster(strength: number) {
  let nodes: SimNode[] = [];

  function force(alpha: number) {
    // Compute category centroids
    const centroids = new Map<string, { x: number; y: number; count: number }>();

    for (const node of nodes) {
      const c = centroids.get(node.category);
      if (c) {
        c.x += node.x;
        c.y += node.y;
        c.count++;
      } else {
        centroids.set(node.category, { x: node.x, y: node.y, count: 1 });
      }
    }

    // Nudge nodes toward their category centroid
    for (const node of nodes) {
      const c = centroids.get(node.category);
      if (!c || c.count <= 1) continue;
      const cx = c.x / c.count;
      const cy = c.y / c.count;
      node.vx += (cx - node.x) * strength * alpha;
      node.vy += (cy - node.y) * strength * alpha;
    }
  }

  force.initialize = (n: SimNode[]) => { nodes = n; };

  return force;
}

// ── API → Simulation Node Conversion ─────────────────────────────────

function toSimNode(node: GraphNode, existing?: SimNode): SimNode {
  return {
    id: node.id,
    name: node.name,
    category: node.category,
    importance: node.importance,
    confidence: node.confidence ?? 0,
    documentFrequency: node.documentFrequency,
    color: node.color,
    radius: importanceToRadius(node.importance),
    // Preserve position from previous run, or start random
    x: existing?.x ?? (Math.random() - 0.5) * 400,
    y: existing?.y ?? (Math.random() - 0.5) * 400,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  };
}

function toSimLinks(links: GraphLink[]): SimLink[] {
  return links.map(l => ({
    source: l.source,
    target: l.target,
    strength: l.strength,
    sharedConversations: l.sharedConversations,
  }));
}

// ── Hook ─────────────────────────────────────────────────────────────

export interface UseForceSimulationResult {
  nodesRef: React.MutableRefObject<SimNode[]>;
  linksRef: React.MutableRefObject<SimLink[]>;
  tickRef: React.MutableRefObject<number>;
  reheat: () => void;
  pinNode: (id: string, x: number, y: number) => void;
  unpinNode: (id: string) => void;
}

export function useForceSimulation(
  nodes: GraphNode[],
  links: GraphLink[],
  width: number,
  height: number,
  config?: Partial<ForceConfig>,
): UseForceSimulationResult {
  const cfg = { ...DEFAULT_FORCE_CONFIG, ...config };
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const tickRef = useRef(0);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);

  // Build/rebuild simulation when data changes
  useEffect(() => {
    // Merge with existing positions
    const existingMap = new Map(nodesRef.current.map(n => [n.id, n]));
    const simNodes = nodes.map(n => toSimNode(n, existingMap.get(n.id)));
    const simLinks = toSimLinks(links);

    nodesRef.current = simNodes;
    linksRef.current = simLinks;

    // Stop previous simulation
    simRef.current?.stop();

    const sim = forceSimulation<SimNode, SimLink>(simNodes)
      .alphaDecay(cfg.alphaDecay)
      .force('center', forceCenter(width / 2, height / 2).strength(cfg.centerStrength))
      .force('charge', forceManyBody<SimNode>()
        .strength((d: SimulationNodeDatum) => cfg.chargeStrength * (0.5 + (d as SimNode).importance))
        .distanceMax(cfg.chargeDistanceMax)
      )
      .force('link', forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(d => cfg.linkDistance / Math.max(0.1, (d as SimLink).strength))
        .strength(d => (d as SimLink).strength * cfg.linkStrengthMultiplier)
      )
      .force('collide', forceCollide<SimNode>()
        .radius(d => d.radius + cfg.collisionPadding)
      )
      .force('cluster', forceCluster(cfg.clusterStrength))
      .on('tick', () => {
        tickRef.current++;
      });

    simRef.current = sim;

    return () => { sim.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links, width, height]);

  const reheat = useCallback(() => {
    simRef.current?.alpha(0.3).restart();
  }, []);

  const pinNode = useCallback((id: string, x: number, y: number) => {
    const node = nodesRef.current.find(n => n.id === id);
    if (node) {
      node.fx = x;
      node.fy = y;
    }
    simRef.current?.alpha(0.1).restart();
  }, []);

  const unpinNode = useCallback((id: string) => {
    const node = nodesRef.current.find(n => n.id === id);
    if (node) {
      node.fx = null;
      node.fy = null;
    }
    simRef.current?.alpha(0.1).restart();
  }, []);

  return { nodesRef, linksRef, tickRef, reheat, pinNode, unpinNode };
}
