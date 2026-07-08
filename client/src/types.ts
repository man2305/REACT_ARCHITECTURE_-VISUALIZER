import type { ArchitectureGraph, GraphEdge, GraphNode } from "@rav/shared";

export type ActiveView = "architecture" | "imports" | "routes" | "hooks" | "api";

export type LoadedGraph = {
  name: string;
  graph: ArchitectureGraph;
};

export type FlowProjection = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};
