import type {
  ArchitectureGraph,
  ArchitectureWarning,
  ComponentInfo,
  GraphEdge,
  GraphNode,
  ImportInfo,
  SourceFile
} from "@rav/shared";
import { extractFile } from "./astExtractors.js";
import {
  buildPathIndex,
  isSourceFile,
  normalizePath,
  resolveRelativeImport
} from "./pathUtils.js";

const LARGE_COMPONENT_LINES = 300;

export function analyzeProject(files: SourceFile[]): ArchitectureGraph {
  const sourceFiles = files
    .map((file) => ({ ...file, path: normalizePath(file.path) }))
    .filter((file) => isSourceFile(file.path));

  const pathIndex = buildPathIndex(sourceFiles.map((file) => file.path));
  const warnings: ArchitectureWarning[] = [];
  const components: ComponentInfo[] = [];

  for (const file of sourceFiles) {
    const result = extractFile(file.path, file.content);

    if (result.parseError) {
      warnings.push({
        type: "parse-error",
        title: "Parse error",
        message: result.parseError,
        filePath: file.path,
        severity: "error"
      });
    }

    for (const component of result.components) {
      const resolvedImports = component.imports.map((importInfo) =>
        resolveImport(component.filePath, importInfo, pathIndex)
      );
      components.push({ ...component, imports: resolvedImports });
    }
  }

  warnings.push(...detectLargeComponents(components));
  warnings.push(...detectDeadComponents(components));
  warnings.push(...detectCircularDependencies(components));

  const { nodes, edges } = buildGraph(components);
  const metrics = {
    fileCount: sourceFiles.length,
    componentCount: components.length,
    importCount: components.reduce((total, component) => total + component.imports.length, 0),
    routeCount: components.reduce((total, component) => total + component.routes.length, 0),
    hookCount: components.reduce((total, component) => total + component.hooks.length, 0),
    apiCallCount: components.reduce((total, component) => total + component.apiCalls.length, 0),
    warningCount: warnings.length,
    architectureScore: scoreArchitecture(components, warnings)
  };

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    components,
    warnings,
    metrics
  };
}

function resolveImport(
  filePath: string,
  importInfo: ImportInfo,
  pathIndex: Map<string, string>
): ImportInfo {
  return {
    ...importInfo,
    resolvedPath: resolveRelativeImport(filePath, importInfo.source, pathIndex)
  };
}

function buildGraph(components: ComponentInfo[]): Pick<ArchitectureGraph, "nodes" | "edges"> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const componentByName = new Map(components.map((component) => [component.name, component]));
  const componentsByFile = groupComponentsByFile(components);

  for (const component of components) {
    upsertNode(nodes, {
      id: componentNodeId(component.name),
      label: component.name,
      kind: "component",
      filePath: component.filePath,
      metadata: {
        lineCount: component.lineCount,
        hookCount: component.hooks.length,
        apiCallCount: component.apiCalls.length
      }
    });

    for (const child of component.jsxChildren) {
      upsertNode(nodes, {
        id: componentNodeId(child),
        label: child,
        kind: componentByName.has(child) ? "component" : "external"
      });
      addEdge(edges, componentNodeId(component.name), componentNodeId(child), "jsx", undefined, {
        props: component.propsToChildren[child] ?? []
      });
    }

    for (const importInfo of component.imports) {
      const importedComponents = importInfo.resolvedPath
        ? componentsByFile.get(importInfo.resolvedPath) ?? []
        : [];

      if (importedComponents.length === 0) {
        const externalId = `external:${importInfo.source}`;
        upsertNode(nodes, {
          id: externalId,
          label: importInfo.source,
          kind: "external"
        });
        addEdge(edges, componentNodeId(component.name), externalId, "import");
      }

      for (const importedComponent of importedComponents) {
        addEdge(
          edges,
          componentNodeId(component.name),
          componentNodeId(importedComponent.name),
          "import",
          importInfo.source
        );
      }
    }

    for (const route of component.routes) {
      const routeId = `route:${route.path}:${route.component ?? "unknown"}`;
      upsertNode(nodes, {
        id: routeId,
        label: route.path,
        kind: "route",
        metadata: route
      });
      addEdge(edges, componentNodeId(component.name), routeId, "route", route.component);

      if (route.component) {
        upsertNode(nodes, {
          id: componentNodeId(route.component),
          label: route.component,
          kind: componentByName.has(route.component) ? "component" : "external"
        });
        addEdge(edges, routeId, componentNodeId(route.component), "route");
      }
    }

    for (const hook of component.hooks) {
      const hookId = `hook:${hook}`;
      upsertNode(nodes, { id: hookId, label: hook, kind: "hook" });
      addEdge(edges, componentNodeId(component.name), hookId, "hook");
    }

    for (const provider of component.providers) {
      const providerId = `provider:${provider}`;
      upsertNode(nodes, { id: providerId, label: provider, kind: "provider" });
      addEdge(edges, componentNodeId(component.name), providerId, "provider");
    }

    for (const apiCall of component.apiCalls) {
      const apiId = `api:${apiCall.method}:${apiCall.endpoint}`;
      upsertNode(nodes, {
        id: apiId,
        label: `${apiCall.method} ${apiCall.endpoint}`,
        kind: "api",
        metadata: apiCall
      });
      addEdge(edges, componentNodeId(component.name), apiId, "api");
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()]
  };
}

function groupComponentsByFile(components: ComponentInfo[]): Map<string, ComponentInfo[]> {
  const map = new Map<string, ComponentInfo[]>();

  for (const component of components) {
    map.set(component.filePath, [...(map.get(component.filePath) ?? []), component]);
  }

  return map;
}

function componentNodeId(name: string): string {
  return `component:${name}`;
}

function upsertNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  nodes.set(node.id, { ...nodes.get(node.id), ...node });
}

function addEdge(
  edges: Map<string, GraphEdge>,
  source: string,
  target: string,
  kind: GraphEdge["kind"],
  label?: string,
  metadata?: Record<string, unknown>
): void {
  const id = `${kind}:${source}->${target}:${label ?? ""}`;
  edges.set(id, { id, source, target, kind, label, metadata });
}

function detectLargeComponents(components: ComponentInfo[]): ArchitectureWarning[] {
  return components
    .filter((component) => component.lineCount >= LARGE_COMPONENT_LINES)
    .map((component) => ({
      type: "large-component",
      title: "Large component",
      message: `${component.name} has ${component.lineCount} lines. Consider splitting it into smaller components.`,
      filePath: component.filePath,
      severity: "warning"
    }));
}

function detectDeadComponents(components: ComponentInfo[]): ArchitectureWarning[] {
  const referenced = new Set<string>();
  const importedNames = new Set<string>();

  for (const component of components) {
    component.jsxChildren.forEach((child) => referenced.add(child));
    component.routes.forEach((route) => {
      if (route.component) {
        referenced.add(route.component);
      }
    });
    component.imports.forEach((importInfo) => {
      importInfo.importedNames.forEach((name) => importedNames.add(name));
    });
  }

  return components
    .filter((component) => {
      const rootLike = ["App", "Root", "Main"].includes(component.name);
      return !rootLike && !referenced.has(component.name) && !importedNames.has(component.name);
    })
    .map((component) => ({
      type: "dead-component",
      title: "Possibly unused component",
      message: `${component.name} was not referenced by JSX, routes, or imports in the analyzed files.`,
      filePath: component.filePath,
      severity: "info"
    }));
}

function detectCircularDependencies(components: ComponentInfo[]): ArchitectureWarning[] {
  const fileGraph = new Map<string, Set<string>>();
  for (const component of components) {
    const edges = fileGraph.get(component.filePath) ?? new Set<string>();
    component.imports.forEach((importInfo) => {
      if (importInfo.resolvedPath && importInfo.resolvedPath !== component.filePath) {
        edges.add(importInfo.resolvedPath);
      }
    });
    fileGraph.set(component.filePath, edges);
  }

  const warnings: ArchitectureWarning[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function visit(file: string, trail: string[]): void {
    if (stack.has(file)) {
      const cycleStart = trail.indexOf(file);
      const cycle = [...trail.slice(cycleStart), file];
      warnings.push({
        type: "circular-dependency",
        title: "Circular dependency",
        message: cycle.join(" -> "),
        filePath: file,
        severity: "error",
        metadata: { cycle }
      });
      return;
    }

    if (visited.has(file)) {
      return;
    }

    visited.add(file);
    stack.add(file);

    for (const next of fileGraph.get(file) ?? []) {
      visit(next, [...trail, next]);
    }

    stack.delete(file);
  }

  for (const file of fileGraph.keys()) {
    visit(file, [file]);
  }

  return dedupeWarnings(warnings);
}

function dedupeWarnings(warnings: ArchitectureWarning[]): ArchitectureWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.type}:${warning.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function scoreArchitecture(
  components: ComponentInfo[],
  warnings: ArchitectureWarning[]
): number {
  const penalty = warnings.reduce((total, warning) => {
    if (warning.severity === "error") {
      return total + 18;
    }
    if (warning.severity === "warning") {
      return total + 10;
    }
    return total + 4;
  }, 0);
  const complexityPenalty = Math.max(0, components.length - 40);
  return Math.max(0, Math.min(100, 100 - penalty - complexityPenalty));
}
