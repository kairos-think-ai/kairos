'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { GraphCanvasProps, InteractionState, SimNode, ThemeColors, CommunityData } from './types';
import { useForceSimulation } from './useForceSimulation';
import { drawGraph } from './canvasRenderer';
import { detectCommunities } from './clustering';
import {
  screenToWorld,
  buildQuadtree,
  findNodeAtPoint,
  zoomAtPoint,
  distance,
} from './interactions';
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_SENSITIVITY,
  CLICK_DISTANCE_THRESHOLD,
} from './constants';

export default function GraphCanvas({
  nodes,
  links,
  selectedNodeId,
  searchQuery,
  minConnections,
  minLinkStrength,
  forceConfig,
  onNodeClick,
  onNodeHover,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ width: 800, height: 600 });
  const interactionRef = useRef<InteractionState>({
    hoveredNodeId: null,
    selectedNodeId: selectedNodeId,
    draggedNodeId: null,
    transform: { x: 0, y: 0, k: 1 },
    isDraggingBackground: false,
    dragOrigin: null,
    mouseDownPos: null,
  });
  const dirtyRef = useRef(true);

  // Read CSS variables for Canvas rendering (Canvas can't access CSS vars directly)
  const themeRef = useRef<ThemeColors>({
    bgPrimary: '#0A0A0F', bgSecondary: '#16161D',
    textPrimary: '#F0F0F5', textSecondary: '#8888A0', textMuted: '#555568',
    accent: '#E5A54B', accentIndigo: '#6366F1', borderSubtle: '#222230',
    fontDisplay: 'Satoshi', fontSans: 'Inter', fontMono: 'JetBrains Mono',
  });

  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const get = (v: string) => style.getPropertyValue(v).trim();
    themeRef.current = {
      bgPrimary: get('--bg-primary') || '#0A0A0F',
      bgSecondary: get('--bg-secondary') || '#16161D',
      textPrimary: get('--text-primary') || '#F0F0F5',
      textSecondary: get('--text-secondary') || '#8888A0',
      textMuted: get('--text-muted') || '#555568',
      accent: get('--accent') || '#E5A54B',
      accentIndigo: get('--accent-indigo') || '#6366F1',
      borderSubtle: get('--border-subtle') || '#222230',
      fontDisplay: 'Satoshi', fontSans: 'Inter', fontMono: 'JetBrains Mono',
    };
  }, []);

  // Run Louvain community detection when data changes
  const communitiesRef = useRef<CommunityData | undefined>(undefined);
  useEffect(() => {
    if (nodes.length > 2 && links.length > 0) {
      const communityNodes = nodes.map(n => ({ id: n.id, category: n.category }));
      const communityLinks = links.map(l => ({
        source: l.source,
        target: l.target,
        sharedConversations: l.sharedConversations || 1,
      }));
      communitiesRef.current = detectCommunities(communityNodes, communityLinks);
      dirtyRef.current = true;
    }
  }, [nodes, links]);

  const rafRef = useRef<number>(0);
  const lastTickRef = useRef(0);

  // Sync selectedNodeId from parent
  useEffect(() => {
    interactionRef.current.selectedNodeId = selectedNodeId;
    dirtyRef.current = true;
  }, [selectedNodeId]);

  // Sync search query triggers redraw
  useEffect(() => {
    dirtyRef.current = true;
  }, [searchQuery]);

  const { nodesRef, linksRef, tickRef, reheat, pinNode, unpinNode } =
    useForceSimulation(nodes, links, sizeRef.current.width, sizeRef.current.height, forceConfig);

  // ── Canvas Sizing ────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        sizeRef.current = { width, height };

        const canvas = canvasRef.current;
        if (canvas) {
          const dpr = window.devicePixelRatio || 1;
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
          dirtyRef.current = true;
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── Render Loop ──────────────────────────────────────────────────

  useEffect(() => {
    function frame() {
      const tick = tickRef.current;
      if (tick !== lastTickRef.current || dirtyRef.current) {
        lastTickRef.current = tick;
        dirtyRef.current = false;

        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (ctx && canvas) {
          const dpr = window.devicePixelRatio || 1;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

          drawGraph(ctx, {
            nodes: nodesRef.current,
            links: linksRef.current,
            transform: interactionRef.current.transform,
            hoveredNodeId: interactionRef.current.hoveredNodeId,
            selectedNodeId: interactionRef.current.selectedNodeId,
            searchQuery,
            minConnections,
            minLinkStrength,
            theme: themeRef.current,
            communities: communitiesRef.current,
            width: sizeRef.current.width,
            height: sizeRef.current.height,
          });
        }
      }
      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [nodesRef, linksRef, tickRef, searchQuery]);

  // ── Event Handlers ───────────────────────────────────────────────

  const getMousePos = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const hitTest = useCallback((screenX: number, screenY: number): SimNode | null => {
    const world = screenToWorld(screenX, screenY, interactionRef.current.transform);
    const tree = buildQuadtree(nodesRef.current);
    return findNodeAtPoint(world.x, world.y, tree);
  }, [nodesRef]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = getMousePos(e);
    const state = interactionRef.current;

    // Dragging a node
    if (state.draggedNodeId) {
      const world = screenToWorld(pos.x, pos.y, state.transform);
      pinNode(state.draggedNodeId, world.x, world.y);
      dirtyRef.current = true;
      return;
    }

    // Panning background
    if (state.isDraggingBackground && state.dragOrigin) {
      state.transform.x += pos.x - state.dragOrigin.x;
      state.transform.y += pos.y - state.dragOrigin.y;
      state.dragOrigin = pos;
      dirtyRef.current = true;
      return;
    }

    // Hover detection
    const node = hitTest(pos.x, pos.y);
    const newHoveredId = node?.id ?? null;

    if (newHoveredId !== state.hoveredNodeId) {
      state.hoveredNodeId = newHoveredId;
      dirtyRef.current = true;
      onNodeHover?.(newHoveredId);
    }

    // Cursor
    if (canvasRef.current) {
      canvasRef.current.style.cursor = newHoveredId ? 'pointer' : 'grab';
    }
  }, [getMousePos, hitTest, pinNode, onNodeHover]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = getMousePos(e);
    const state = interactionRef.current;
    state.mouseDownPos = pos;

    const node = hitTest(pos.x, pos.y);
    if (node) {
      // Start dragging node
      state.draggedNodeId = node.id;
      const world = screenToWorld(pos.x, pos.y, state.transform);
      pinNode(node.id, world.x, world.y);
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    } else {
      // Start panning
      state.isDraggingBackground = true;
      state.dragOrigin = pos;
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    }
  }, [getMousePos, hitTest, pinNode]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const pos = getMousePos(e);
    const state = interactionRef.current;
    const wasClick = state.mouseDownPos &&
      distance(pos, state.mouseDownPos) < CLICK_DISTANCE_THRESHOLD;

    // Release dragged node
    if (state.draggedNodeId) {
      unpinNode(state.draggedNodeId);
      state.draggedNodeId = null;
    }

    // Stop panning
    state.isDraggingBackground = false;
    state.dragOrigin = null;

    // Handle click (not drag)
    if (wasClick) {
      const node = hitTest(pos.x, pos.y);
      if (node) {
        onNodeClick?.(node.id);
      } else {
        // Click on empty space — deselect
        onNodeClick?.('');
      }
    }

    state.mouseDownPos = null;
    if (canvasRef.current) {
      canvasRef.current.style.cursor = state.hoveredNodeId ? 'pointer' : 'grab';
    }
    dirtyRef.current = true;
  }, [getMousePos, hitTest, unpinNode, onNodeClick]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const pos = getMousePos(e);
    const state = interactionRef.current;

    state.transform = zoomAtPoint(
      state.transform,
      pos.x,
      pos.y,
      e.deltaY * ZOOM_SENSITIVITY,
      ZOOM_MIN,
      ZOOM_MAX,
    );

    dirtyRef.current = true;
  }, [getMousePos]);

  const handleMouseLeave = useCallback(() => {
    const state = interactionRef.current;
    if (state.hoveredNodeId) {
      state.hoveredNodeId = null;
      dirtyRef.current = true;
      onNodeHover?.(null);
    }
    if (state.draggedNodeId) {
      unpinNode(state.draggedNodeId);
      state.draggedNodeId = null;
    }
    state.isDraggingBackground = false;
    state.dragOrigin = null;
  }, [unpinNode, onNodeHover]);

  // ── Empty State ──────────────────────────────────────────────────

  if (nodes.length === 0) {
    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontSize: '14px',
      }}>
        No concepts yet. Import and analyze conversations first.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onMouseLeave={handleMouseLeave}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          cursor: 'grab',
        }}
      />
    </div>
  );
}
