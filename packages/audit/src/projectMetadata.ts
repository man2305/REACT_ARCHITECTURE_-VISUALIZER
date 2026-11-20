import type { ArchitectureGraph, ComponentInfo } from "@rav/shared";
import type {
  ArchitectureMetricsMetadata,
  ComponentMetadata,
  DependencyGraphMetadata,
  FolderNode,
  ProjectAuditMetadata,
  WarningMetadata
} from "./types.js";

function toComponentMetadata(component: ComponentInfo): ComponentMetadata {
  return {
    name: component.name,
    file: component.filePath,
    lines: component.lineCount,
    imports: component.imports.length,
    children: component.jsxChildren.length,
    hooks: component.hooks,
    apiCalls: component.apiCalls.length,
    routes: component.routes.length,
    exported: component.exported
  };
}

function buildFolderStructure(components: ComponentInfo[]): FolderNode {
  const root: FolderNode = { files: [], subfolders: {}, componentCount: 0 };

  for (const component of components) {
    const parts = component.filePath.split("/").filter(Boolean);
    const fileName = parts.pop() ?? component.filePath;
    let current = root;

    for (const part of parts) {
      current.subfolders[part] ??= { files: [], subfolders: {}, componentCount: 0 };
      current = current.subfolders[part];
    }

    current.files.push(fileName);
    current.componentCount += 1;
  }

  return root;
}

function computeDeepestTree(graph: ArchitectureGraph): number {
  const jsxEdges = graph.edges.filter((edge) => edge.kind === "jsx");
  const childrenByParent = new Map<string, string[]>();

  for (const edge of jsxEdges) {
    if (!edge.source.startsWith("component:") || !edge.target.startsWith("component:")) {
      continue;
    }
    const parent = edge.source.replace("component:", "");
    const child = edge.target.replace("component:", "");
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), child]);
  }

  const memo = new Map<string, number>();

  function depth(name: string, visiting: Set<string>): number {
    if (memo.has(name)) {
      return memo.get(name)!;
    }
    if (visiting.has(name)) {
      return 1;
    }

    visiting.add(name);
    const children = childrenByParent.get(name) ?? [];
    const childDepth =
      children.length === 0 ? 0 : Math.max(...children.map((child) => depth(child, visiting)));
    visiting.delete(name);

    const result = 1 + childDepth;
    memo.set(name, result);
    return result;
  }

  const roots = [...childrenByParent.keys()].filter(
    (name) => ![...childrenByParent.values()].flat().includes(name)
  );

  if (roots.length === 0) {
    return componentsMaxDepth(graph.components, childrenByParent);
  }

  return Math.max(...roots.map((root) => depth(root, new Set())), 1);
}

function componentsMaxDepth(
  components: ComponentInfo[],
  childrenByParent: Map<string, string[]>
): number {
  if (components.length === 0) {
    return 0;
  }

  return Math.max(
    ...components.map((component) => {
      const children = childrenByParent.get(component.name) ?? [];
      return children.length > 0 ? 2 : 1;
    })
  );
}

function computeArchitectureMetrics(
  components: ComponentMetadata[],
  graph: ArchitectureGraph
): ArchitectureMetricsMetadata {
  const count = components.length || 1;
  const largest = [...components].sort((a, b) => b.lines - a.lines)[0];

  const contextCount = graph.nodes.filter((node) => node.kind === "provider").length;

  return {
    averageComponentSize: Math.round(components.reduce((sum, c) => sum + c.lines, 0) / count),
    largestComponent: largest?.name ?? "N/A",
    averageImports: Math.round((components.reduce((sum, c) => sum + c.imports, 0) / count) * 10) / 10,
    averageChildren:
      Math.round((components.reduce((sum, c) => sum + c.children, 0) / count) * 10) / 10,
    deepestComponentTree: computeDeepestTree(graph),
    contextCount
  };
}

function buildDependencyGraph(graph: ArchitectureGraph): DependencyGraphMetadata {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind
    })),
    edges: graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind
    }))
  };
}

function extractUnusedComponents(warnings: ArchitectureGraph["warnings"]): string[] {
  return warnings
    .filter((warning) => warning.type === "dead-component")
    .map((warning) => {
      const match = warning.message.match(/^(\w+) was not referenced/);
      return match?.[1] ?? warning.title;
    });
}

function extractCircularDependencies(warnings: ArchitectureGraph["warnings"]): string[][] {
  return warnings
    .filter((warning) => warning.type === "circular-dependency")
    .map((warning) => {
      const cycle = warning.metadata?.cycle;
      return Array.isArray(cycle) ? (cycle as string[]) : warning.message.split(" -> ");
    });
}

export function generateProjectMetadata(
  projectName: string,
  graph: ArchitectureGraph
): ProjectAuditMetadata {
  const components = graph.components.map(toComponentMetadata);
  const largestComponents = [...components].sort((a, b) => b.lines - a.lines).slice(0, 10);
  const uniqueHooks = new Set(graph.components.flatMap((component) => component.hooks));

  const warnings: WarningMetadata[] = graph.warnings.map((warning) => ({
    type: warning.type,
    title: warning.title,
    message: warning.message,
    severity: warning.severity,
    suggestion: warning.suggestion,
    filePath: warning.filePath
  }));

  return {
    projectName,
    framework: "React",
    statistics: {
      totalFiles: graph.metrics.fileCount,
      components: graph.metrics.componentCount,
      hooks: uniqueHooks.size,
      routes: graph.metrics.routeCount,
      contexts: graph.nodes.filter((node) => node.kind === "provider").length,
      apiCalls: graph.metrics.apiCallCount
    },
    components,
    largestComponents,
    folderStructure: buildFolderStructure(graph.components),
    dependencyGraph: buildDependencyGraph(graph),
    architectureMetrics: computeArchitectureMetrics(components, graph),
    warnings,
    unusedComponents: extractUnusedComponents(graph.warnings),
    circularDependencies: extractCircularDependencies(graph.warnings),
    architectureScore: graph.metrics.architectureScore
  };
}

export function isMetadataEmpty(metadata: ProjectAuditMetadata): boolean {
  return metadata.statistics.components === 0 && metadata.statistics.totalFiles === 0;
}
