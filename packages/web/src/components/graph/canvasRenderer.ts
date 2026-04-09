import type { SimNode, SimLink, GraphTransform, ThemeColors, CommunityData } from './types';
import {
  EDGE_OPACITY_BASE,
  EDGE_OPACITY_STRENGTH_MULT,
  EDGE_WIDTH_BASE,
  EDGE_WIDTH_STRENGTH_MULT,
  NODE_GLOW_BLUR,
  SELECTED_RING_OFFSET,
  SELECTED_RING_WIDTH,
  HOVER_RING_OFFSET,
  LABEL_SHOW_THRESHOLD,
  LABEL_FONT_SIZE,
  LABEL_PADDING_X,
  LABEL_PADDING_Y,
  DIM_OPACITY_UNCONNECTED,
  DIM_OPACITY_SEARCH_MISS,
} from './constants';

// ── Helper: hex to rgba ──────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Precompute Connection Sets ───────────────────────────────────────

function getConnectedNodeIds(
  selectedId: string | null,
  links: SimLink[],
): Set<string> {
  const connected = new Set<string>();
  if (!selectedId) return connected;
  connected.add(selectedId);

  for (const link of links) {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    if (sourceId === selectedId) connected.add(targetId);
    if (targetId === selectedId) connected.add(sourceId);
  }

  return connected;
}

function matchesSearch(name: string, query: string): boolean {
  if (!query) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

// ── Node Opacity ─────────────────────────────────────────────────────

function getNodeOpacity(
  node: SimNode,
  selectedId: string | null,
  connectedIds: Set<string>,
  searchQuery: string,
): number {
  // Search filtering takes priority
  if (searchQuery && !matchesSearch(node.name, searchQuery)) {
    return DIM_OPACITY_SEARCH_MISS;
  }
  // Selection dimming
  if (selectedId && !connectedIds.has(node.id)) {
    return DIM_OPACITY_UNCONNECTED;
  }
  return 1.0;
}

// ── Main Draw Function ───────────────────────────────────────────────

export interface DrawOptions {
  nodes: SimNode[];
  links: SimLink[];
  transform: GraphTransform;
  hoveredNodeId: string | null;
  selectedNodeId: string | null;
  searchQuery: string;
  minConnections?: number;
  minLinkStrength?: number;
  theme: ThemeColors;
  communities?: CommunityData;
  width: number;
  height: number;
}

export function drawGraph(ctx: CanvasRenderingContext2D, opts: DrawOptions) {
  const { nodes, links, transform, hoveredNodeId, selectedNodeId, searchQuery, minConnections, minLinkStrength, theme, communities, width, height } = opts;

  // Filter links by strength threshold
  const filteredLinks = minLinkStrength
    ? links.filter(l => l.strength >= minLinkStrength)
    : links;

  // Count connections per node (from filtered links)
  const connectionCount = new Map<string, number>();
  for (const link of filteredLinks) {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    connectionCount.set(sourceId, (connectionCount.get(sourceId) || 0) + 1);
    connectionCount.set(targetId, (connectionCount.get(targetId) || 0) + 1);
  }

  // Filter nodes by minimum connections (Thought Depth)
  const visibleNodeIds = new Set<string>();
  for (const node of nodes) {
    const count = connectionCount.get(node.id) || 0;
    if (!minConnections || count >= minConnections) {
      visibleNodeIds.add(node.id);
    }
  }
  const filteredNodes = nodes.filter(n => visibleNodeIds.has(n.id));

  const connectedIds = getConnectedNodeIds(selectedNodeId, filteredLinks);

  // 1. Clear
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.bgPrimary;
  ctx.fillRect(0, 0, width, height);

  // 2. Apply transform
  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  // 2.5. Draw community hulls (behind edges and nodes)
  if (communities) {
    drawCommunityHulls(ctx, filteredNodes, communities, transform.k);
  }

  // 3. Draw edges (only between visible nodes)
  const visibleLinks = filteredLinks.filter(l => {
    const sourceId = typeof l.source === 'string' ? l.source : l.source.id;
    const targetId = typeof l.target === 'string' ? l.target : l.target.id;
    return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId);
  });
  drawEdges(ctx, visibleLinks, selectedNodeId, connectedIds, searchQuery, filteredNodes);

  // 4. Draw nodes (filtered)
  drawNodes(ctx, filteredNodes, selectedNodeId, hoveredNodeId, connectedIds, searchQuery);

  // 5. Draw labels (filtered)
  drawLabels(ctx, filteredNodes, selectedNodeId, hoveredNodeId, connectedIds, searchQuery, transform.k);

  ctx.restore();

  // 6. Draw tooltip (screen space)
  if (hoveredNodeId) {
    const node = nodes.find(n => n.id === hoveredNodeId);
    if (node) {
      drawTooltip(ctx, node, transform, theme);
    }
  }
}

// ── Edge Drawing ─────────────────────────────────────────────────────

function drawEdges(
  ctx: CanvasRenderingContext2D,
  links: SimLink[],
  selectedId: string | null,
  connectedIds: Set<string>,
  searchQuery: string,
  nodes: SimNode[],
) {
  for (const link of links) {
    const source = link.source as SimNode;
    const target = link.target as SimNode;
    if (!source.x || !target.x) continue;

    const sourceId = source.id;
    const targetId = target.id;

    let opacity = EDGE_OPACITY_BASE + link.strength * EDGE_OPACITY_STRENGTH_MULT;
    let lineWidth = EDGE_WIDTH_BASE + link.strength * EDGE_WIDTH_STRENGTH_MULT;

    // Dim edges not connected to selected node
    if (selectedId) {
      const isConnectedEdge = connectedIds.has(sourceId) && connectedIds.has(targetId);
      if (isConnectedEdge) {
        opacity = 0.15 + link.strength * 0.4;
        lineWidth *= 1.5;
      } else {
        opacity = 0.02;
      }
    }

    // Dim edges for search misses
    if (searchQuery) {
      const sourceMatch = matchesSearch(source.name, searchQuery);
      const targetMatch = matchesSearch(target.name, searchQuery);
      if (!sourceMatch && !targetMatch) opacity = 0.01;
    }

    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.strokeStyle = `rgba(255,255,255,${opacity})`;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

// ── Node Drawing ─────────────────────────────────────────────────────

function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: SimNode[],
  selectedId: string | null,
  hoveredId: string | null,
  connectedIds: Set<string>,
  searchQuery: string,
) {
  for (const node of nodes) {
    const opacity = getNodeOpacity(node, selectedId, connectedIds, searchQuery);
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;

    // Glow effect for hover/selected
    if (isSelected || isHovered) {
      ctx.save();
      ctx.shadowBlur = NODE_GLOW_BLUR;
      ctx.shadowColor = node.color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(node.color, opacity * 0.5);
      ctx.fill();
      ctx.restore();
    }

    // Main circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(node.color, opacity);
    ctx.fill();

    // Selected ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + SELECTED_RING_OFFSET, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${opacity})`;
      ctx.lineWidth = SELECTED_RING_WIDTH;
      ctx.stroke();
    }

    // Hover ring
    if (isHovered && !isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + HOVER_RING_OFFSET, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(node.color, 0.6 * opacity);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ── Label Drawing ────────────────────────────────────────────────────

function drawLabels(
  ctx: CanvasRenderingContext2D,
  nodes: SimNode[],
  selectedId: string | null,
  hoveredId: string | null,
  connectedIds: Set<string>,
  searchQuery: string,
  zoom: number,
) {
  const fontSize = Math.max(9, LABEL_FONT_SIZE / zoom);
  ctx.font = `500 ${fontSize}px Inter, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (const node of nodes) {
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;
    const effectiveRadius = node.radius * zoom;

    // Show label if large enough, or hovered/selected
    if (effectiveRadius < LABEL_SHOW_THRESHOLD && !isSelected && !isHovered) continue;

    const opacity = getNodeOpacity(node, selectedId, connectedIds, searchQuery);
    if (opacity < 0.2) continue; // Don't label nearly-invisible nodes

    const labelY = node.y + node.radius + 4 / zoom;
    const text = node.name;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;

    // Background pill
    const px = LABEL_PADDING_X / zoom;
    const py = LABEL_PADDING_Y / zoom;
    ctx.fillStyle = `rgba(10,10,15,${0.8 * opacity})`;
    ctx.beginPath();
    const r = 3 / zoom;
    const x0 = node.x - textWidth / 2 - px;
    const y0 = labelY - py;
    const w = textWidth + px * 2;
    const h = fontSize + py * 2;
    ctx.roundRect(x0, y0, w, h, r);
    ctx.fill();

    // Text
    ctx.fillStyle = isSelected
      ? `rgba(240,240,245,${opacity})`
      : `rgba(136,136,160,${opacity})`;
    ctx.fillText(text, node.x, labelY);
  }
}

// ── Tooltip Drawing (screen space) ───────────────────────────────────

function drawTooltip(
  ctx: CanvasRenderingContext2D,
  node: SimNode,
  transform: GraphTransform,
  theme: ThemeColors,
) {
  const screenX = node.x * transform.k + transform.x;
  const screenY = node.y * transform.k + transform.y;

  const lines = [
    node.name,
    `${node.category} · importance: ${node.importance.toFixed(2)}`,
    `appears in ${node.documentFrequency} conversation${node.documentFrequency !== 1 ? 's' : ''}`,
  ];

  const fontSize = 12;
  const lineHeight = 18;
  const padding = 10;
  ctx.font = `${fontSize}px Inter, -apple-system, sans-serif`;

  const maxWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
  const tooltipWidth = maxWidth + padding * 2;
  const tooltipHeight = lines.length * lineHeight + padding * 2;

  // Position tooltip above and to the right of the node
  let tx = screenX + 15;
  let ty = screenY - tooltipHeight - 10;

  // Keep on screen
  const canvasWidth = ctx.canvas.width / (window.devicePixelRatio || 1);
  const canvasHeight = ctx.canvas.height / (window.devicePixelRatio || 1);
  if (tx + tooltipWidth > canvasWidth) tx = screenX - tooltipWidth - 15;
  if (ty < 0) ty = screenY + 20;

  // Background
  ctx.fillStyle = 'rgba(22,22,29,0.95)';
  ctx.beginPath();
  ctx.roundRect(tx, ty, tooltipWidth, tooltipHeight, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(34,34,48,1)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Text
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? theme.textPrimary : theme.textSecondary;
    if (i === 0) ctx.font = `600 ${fontSize}px Inter, -apple-system, sans-serif`;
    else ctx.font = `${fontSize}px Inter, -apple-system, sans-serif`;
    ctx.fillText(line, tx + padding, ty + padding + i * lineHeight);
  });
}

// ── Community Hull Drawing ───────────────────────────────────────────

import { convexHull, expandHull } from './clustering';

function drawCommunityHulls(
  ctx: CanvasRenderingContext2D,
  nodes: SimNode[],
  communities: CommunityData,
  zoom: number,
) {
  for (const [comId, memberIds] of communities.communities) {
    if (memberIds.length < 3) continue; // Need 3+ nodes for a hull

    // Get positions of community members
    const points = memberIds
      .map(id => nodes.find(n => n.id === id))
      .filter((n): n is SimNode => n !== undefined && n.x !== undefined)
      .map(n => ({ x: n.x, y: n.y }));

    if (points.length < 3) continue;

    // Compute convex hull with padding
    const hull = convexHull(points);
    const expanded = expandHull(hull, 30); // 30px padding around nodes

    const color = communities.colors.get(comId) || '#6366F1';
    const label = communities.labels.get(comId) || '';

    // Draw filled hull (very low opacity)
    ctx.beginPath();
    ctx.moveTo(expanded[0].x, expanded[0].y);
    for (let i = 1; i < expanded.length; i++) {
      ctx.lineTo(expanded[i].x, expanded[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, 0.04);
    ctx.fill();

    // Draw dashed border
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = hexToRgba(color, 0.15);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw label above hull
    if (label && zoom > 0.4) {
      const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
      const minY = Math.min(...expanded.map(p => p.y));

      const labelFontSize = Math.max(9, 10 / zoom);
      ctx.font = `600 ${labelFontSize}px Inter, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = hexToRgba(color, 0.5);
      ctx.fillText(label, cx, minY - 8);
    }
  }
}
