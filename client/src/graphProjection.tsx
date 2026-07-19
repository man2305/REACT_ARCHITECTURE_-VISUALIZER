import dagre from "@dagrejs/dagre";
import { Position, type Edge, type Node } from "@xyflow/react";
import type { ArchitectureGraph, GraphEdgeKind, GraphNodeKind } from "@rav/shared";
import type { ActiveView } from "./types";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 58;

const nodeColors: Record<GraphNodeKind, string> = {
  component: "#2563eb",
  file: "#475569",
  route: "#7c3aed",
  hook: "#0891b2",
  api: "#dc2626",
  provider: "#16a34a",
  external: "#64748b"
};

const nodeColorsDark: Record<GraphNodeKind, string> = {
  component: "#60a5fa",
  file: "#94a3b8",
  route: "#a78bfa",
  hook: "#22d3ee",
  api: "#f87171",
  provider: "#4ade80",
  external: "#94a3b8"
};

const edgeLabels: Record<GraphEdgeKind, string> = {
  jsx: "renders",
  import: "imports",
  route: "routes",
  hook: "uses",
  api: "calls",
  provider: "provides"
};

type GraphSelection = {
  edgeId: string;
  nodeIds: Set<string>;
};

export function toFlowGraph(
  graph: ArchitectureGraph,
  activeView: ActiveView,
  selection?: GraphSelection,
  isDark = false,
  searchQuery = ""
): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const visibleEdges = filterVisibleEdges(graph, activeView, nodesById);
  const visibleNodeIds = new Set<string>();

  visibleEdges.forEach((edge) => {
    visibleNodeIds.add(edge.source);
    visibleNodeIds.add(edge.target);
  });

  if (activeView === "architecture") {
    graph.nodes
      .filter((node) => node.kind === "component")
      .forEach((node) => visibleNodeIds.add(node.id));
  }

  const visibleNodes = graph.nodes.filter((node) => visibleNodeIds.has(node.id));
  const layouted = layoutGraph(visibleNodes, visibleEdges);

  const hasSearch = searchQuery.trim().length > 0;
  const searchLower = searchQuery.toLowerCase();

  return {
    nodes: layouted.map((node) => {
      const isSelected = selection?.nodeIds.has(node.id);
      const colors = isDark ? nodeColorsDark : nodeColors;
      const matchesSearch = !hasSearch || node.label.toLowerCase().includes(searchLower) || node.kind.toLowerCase().includes(searchLower);
      const isDimmed = hasSearch && !matchesSearch;

      return {
        id: node.id,
        position: node.position,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          label: (
            <div className="flow-node">
              <span className="flow-node__kind">{node.kind}</span>
              <strong>{node.label}</strong>
            </div>
          )
        },
        style: {
          border: isSelected
            ? "2px solid #f59e0b"
            : `1px solid ${colors[node.kind]}`,
          borderLeft: isSelected
            ? "6px solid #f59e0b"
            : `5px solid ${colors[node.kind]}`,
          color: isDark ? "#e2e8f0" : "#0f172a",
          background: isSelected ? (isDark ? "#422006" : "#fffbeb") : isDark ? "#1e293b" : "#ffffff",
          borderRadius: 8,
          width: NODE_WIDTH,
          opacity: isDimmed ? 0.15 : 1,
          boxShadow: isSelected
            ? "0 0 0 4px rgba(245, 158, 11, 0.22), 0 16px 32px rgba(15, 23, 42, 0.14)"
            : isDimmed
              ? "none"
              : isDark
                ? "0 10px 24px rgba(0, 0, 0, 0.35)"
                : "0 10px 24px rgba(15, 23, 42, 0.08)",
          transition: "opacity 200ms ease, border-color 200ms ease, box-shadow 200ms ease"
        }
      };
    }),
    edges: visibleEdges.map((edge) => {
      const isSelected = selection?.edgeId === edge.id;
      const sourceNode = nodesById.get(edge.source);
      const targetNode = nodesById.get(edge.target);
      const edgeMatchesSearch = !hasSearch ||
        (sourceNode && sourceNode.label.toLowerCase().includes(searchLower)) ||
        (targetNode && targetNode.label.toLowerCase().includes(searchLower));
      const isDimmed = hasSearch && !edgeMatchesSearch;

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: isSelected || edge.kind === "api" || edge.kind === "route",
        label: activeView === "architecture" ? undefined : edge.label ?? edgeLabels[edge.kind],
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 6,
        labelBgStyle: {
          fill: isDark ? "#1e293b" : "#ffffff",
          fillOpacity: 0.92
        },
        labelStyle: {
          fill: isDark ? "#cbd5e1" : "#334155",
          fontWeight: 700,
          fontSize: 11
        },
        type: activeView === "architecture" ? "default" : "smoothstep",
        interactionWidth: 18,
        style: {
          stroke: isSelected ? "#f59e0b" : edge.kind === "jsx" ? (isDark ? "#60a5fa" : "#2563eb") : isDark ? "#94a3b8" : "#64748b",
          strokeOpacity: isDimmed ? 0.08 : selection && !isSelected ? 0.32 : 1,
          strokeWidth: isSelected ? 4 : edge.kind === "jsx" ? 2.4 : 1.8
        },
        zIndex: isSelected ? 2 : 0
      };
    })
  };
}

function filterVisibleEdges(
  graph: ArchitectureGraph,
  activeView: ActiveView,
  nodesById: Map<string, ArchitectureGraph["nodes"][number]>
): ArchitectureGraph["edges"] {
  if (activeView === "architecture") {
    return graph.edges.filter((edge) => {
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      return edge.kind === "jsx" && source?.kind === "component" && target?.kind === "component";
    });
  }

  const allowedEdges = filterEdgeKinds(activeView);
  return graph.edges.filter((edge) => allowedEdges.has(edge.kind));
}

function filterEdgeKinds(activeView: ActiveView): Set<GraphEdgeKind> {
  if (activeView === "architecture") {
    return new Set(["jsx", "route"]);
  }

  if (activeView === "imports") {
    return new Set(["import"]);
  }

  if (activeView === "routes") {
    return new Set(["route"]);
  }

  if (activeView === "hooks") {
    return new Set(["hook", "provider"]);
  }

  return new Set(["api"]);
}

function layoutGraph(
  nodes: ArchitectureGraph["nodes"],
  edges: ArchitectureGraph["edges"]
): Array<ArchitectureGraph["nodes"][number] & { position: { x: number; y: number } }> {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "TB",
    nodesep: 90,
    ranksep: 140,
    edgesep: 48,
    ranker: "tight-tree"
  });

  nodes.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  return nodes.map((node) => {
    const position = graph.node(node.id) as { x: number; y: number } | undefined;
    return {
      ...node,
      position: {
        x: (position?.x ?? 0) - NODE_WIDTH / 2,
        y: (position?.y ?? 0) - NODE_HEIGHT / 2
      }
    };
  });
}
