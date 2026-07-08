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

const edgeLabels: Record<GraphEdgeKind, string> = {
  jsx: "renders",
  import: "imports",
  route: "routes",
  hook: "uses",
  api: "calls",
  provider: "provides"
};

export function toFlowGraph(graph: ArchitectureGraph, activeView: ActiveView): {
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

  return {
    nodes: layouted.map((node) => ({
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
        border: `1px solid ${nodeColors[node.kind]}`,
        borderLeft: `5px solid ${nodeColors[node.kind]}`,
        color: "#0f172a",
        background: "#ffffff",
        borderRadius: 8,
        width: NODE_WIDTH,
        boxShadow: "0 10px 24px rgba(15, 23, 42, 0.08)"
      }
    })),
    edges: visibleEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: edge.kind === "api" || edge.kind === "route",
      label: activeView === "architecture" ? undefined : edge.label ?? edgeLabels[edge.kind],
      labelShowBg: false,
      type: activeView === "architecture" ? "default" : "smoothstep",
      style: {
        stroke: edge.kind === "jsx" ? "#2563eb" : "#64748b",
        strokeWidth: edge.kind === "jsx" ? 2.4 : 1.8
      },
      zIndex: 0
    }))
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
