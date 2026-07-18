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
const GOD_COMPONENT_HOOKS = 5;
const GOD_COMPONENT_API_CALLS = 3;
const GOD_COMPONENT_CHILDREN = 6;
const GOD_COMPONENT_IMPORTS = 8;
const HIGH_FAN_IN_THRESHOLD = 4;
const HIGH_FAN_OUT_THRESHOLD = 8;
const DEEP_NESTING_THRESHOLD = 5;
const HOOK_OVERLOAD_THRESHOLD = 6;
const API_CONCENTRATION_RATIO = 0.6;
const PROVIDER_STACKING_THRESHOLD = 2;
const SR_VIOLATION_THRESHOLD = 3;
const LOW_COHESION_IMPORT_THRESHOLD = 7;
const TIGHT_COUPLING_THRESHOLD = 10;

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
  warnings.push(...detectGodComponents(components));
  warnings.push(...detectHighFanIn(components));
  warnings.push(...detectHighFanOut(components));
  warnings.push(...detectDeepNesting(components));
  warnings.push(...detectHookOverload(components));
  warnings.push(...detectApiConcentration(components));
  warnings.push(...detectProviderStacking(components));
  warnings.push(...detectSingleResponsibilityViolation(components));
  warnings.push(...detectLowCohesion(components));
  warnings.push(...detectMissingCodeSplitting(components));
  warnings.push(...detectTightCoupling(components));

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

function detectGodComponents(components: ComponentInfo[]): ArchitectureWarning[] {
  return components
    .filter((c) => {
      const concerns = [
        c.hooks.length >= GOD_COMPONENT_HOOKS,
        c.apiCalls.length >= GOD_COMPONENT_API_CALLS,
        c.jsxChildren.length >= GOD_COMPONENT_CHILDREN,
        c.imports.length >= GOD_COMPONENT_IMPORTS
      ];
      return concerns.filter(Boolean).length >= 2;
    })
    .map((c) => {
      const issues: string[] = [];
      if (c.hooks.length >= GOD_COMPONENT_HOOKS) {
        issues.push(`${c.hooks.length} hooks`);
      }
      if (c.apiCalls.length >= GOD_COMPONENT_API_CALLS) {
        issues.push(`${c.apiCalls.length} API calls`);
      }
      if (c.jsxChildren.length >= GOD_COMPONENT_CHILDREN) {
        issues.push(`${c.jsxChildren.length} child components`);
      }
      if (c.imports.length >= GOD_COMPONENT_IMPORTS) {
        issues.push(`${c.imports.length} imports`);
      }
      return {
        type: "god-component" as const,
        title: "God component detected",
        message: `${c.name} handles too many concerns: ${issues.join(", ")}. It manages ${c.lineCount} lines across ${c.filePath}.`,
        suggestion: `Split ${c.name} into focused sub-components. Extract data fetching into a custom hook, separate presentation from logic, and delegate child rendering to smaller components.`,
        filePath: c.filePath,
        severity: "error" as const,
        metadata: { hooks: c.hooks.length, apiCalls: c.apiCalls.length, children: c.jsxChildren.length, imports: c.imports.length }
      };
    });
}

function detectHighFanIn(components: ComponentInfo[]): ArchitectureWarning[] {
  const fanIn = new Map<string, number>();
  for (const c of components) {
    for (const child of c.jsxChildren) {
      fanIn.set(child, (fanIn.get(child) ?? 0) + 1);
    }
    for (const route of c.routes) {
      if (route.component) {
        fanIn.set(route.component, (fanIn.get(route.component) ?? 0) + 1);
      }
    }
  }

  return components
    .filter((c) => (fanIn.get(c.name) ?? 0) >= HIGH_FAN_IN_THRESHOLD)
    .map((c) => {
      const count = fanIn.get(c.name)!;
      return {
        type: "high-fan-in" as const,
        title: "High fan-in component",
        message: `${c.name} is used by ${count} other components. Changes to this component have wide impact.`,
        suggestion: `Stabilize ${c.name}'s API surface. Consider using a React Context or compound component pattern to reduce direct coupling. Ensure props interface is well-typed and versioned.`,
        filePath: c.filePath,
        severity: "warning" as const,
        metadata: { fanIn: count }
      };
    });
}

function detectHighFanOut(components: ComponentInfo[]): ArchitectureWarning[] {
  return components
    .filter((c) => c.imports.length + c.jsxChildren.length >= HIGH_FAN_OUT_THRESHOLD)
    .map((c) => {
      const total = c.imports.length + c.jsxChildren.length;
      return {
        type: "high-fan-out" as const,
        title: "High fan-out component",
        message: `${c.name} depends on ${total} other modules (${c.imports.length} imports, ${c.jsxChildren.length} children). High coupling increases change fragility.`,
        suggestion: `Reduce ${c.name}'s dependencies by extracting shared utilities into a services layer, grouping related children into a compound component, or introducing an intermediary container.`,
        filePath: c.filePath,
        severity: "warning" as const,
        metadata: { imports: c.imports.length, children: c.jsxChildren.length, total }
      };
    });
}

function detectDeepNesting(components: ComponentInfo[]): ArchitectureWarning[] {
  const jsxEdges: Array<{ parent: string; child: string }> = [];
  for (const c of components) {
    for (const child of c.jsxChildren) {
      jsxEdges.push({ parent: c.name, child });
    }
  }

  const childrenByParent = new Map<string, string[]>();
  for (const edge of jsxEdges) {
    childrenByParent.set(edge.parent, [...(childrenByParent.get(edge.parent) ?? []), edge.child]);
  }

  const componentSet = new Set(components.map((c) => c.name));
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

  const warnings: ArchitectureWarning[] = [];
  const depthMap = new Map<string, number>();

  for (const c of components) {
    const d = depth(c.name, new Set());
    depthMap.set(c.name, d);
    if (d >= DEEP_NESTING_THRESHOLD) {
      warnings.push({
        type: "deep-nesting" as const,
        title: "Deep component nesting",
        message: `${c.name} sits at depth ${d} in the component tree. Deep nesting increases render complexity and makes prop drilling likely.`,
        suggestion: `Flatten the component tree around ${c.name}. Consider using React Context for shared state, or restructure layout components to reduce nesting depth.`,
        filePath: c.filePath,
        severity: "warning" as const,
        metadata: { depth: d }
      });
    }
  }

  return warnings;
}

function detectHookOverload(components: ComponentInfo[]): ArchitectureWarning[] {
  return components
    .filter((c) => c.hooks.length >= HOOK_OVERLOAD_THRESHOLD)
    .map((c) => ({
      type: "hook-overload" as const,
      title: "Hook overload",
      message: `${c.name} uses ${c.hooks.length} hooks (${c.hooks.join(", ")}). Excessive hooks indicate mixed concerns.`,
      suggestion: `Extract related hooks into a custom compound hook. For example, combine data-fetching hooks into useFetchData() and UI-state hooks into useUIState(). This improves readability and testability.`,
      filePath: c.filePath,
      severity: "warning" as const,
      metadata: { hooks: c.hooks, count: c.hooks.length }
    }));
}

function detectApiConcentration(components: ComponentInfo[]): ArchitectureWarning[] {
  const totalApiCalls = components.reduce((sum, c) => sum + c.apiCalls.length, 0);
  if (totalApiCalls === 0) {
    return [];
  }

  const apiComponents = components.filter((c) => c.apiCalls.length > 0);
  const ratio = apiComponents.length / (components.length || 1);

  if (apiComponents.length <= 1 || ratio > API_CONCENTRATION_RATIO) {
    return [];
  }

  const heaviest = [...apiComponents].sort((a, b) => b.apiCalls.length - a.apiCalls.length).slice(0, 3);

  return [
    {
      type: "api-concentration" as const,
      title: "API calls concentrated in few components",
      message: `${totalApiCalls} API calls are spread across only ${apiComponents.length} of ${components.length} components. Top consumers: ${heaviest.map((c) => `${c.name} (${c.apiCalls.length})`).join(", ")}.`,
      suggestion: "Centralize API calls into a dedicated service layer or data-fetching hooks (e.g., useUsers(), useAuth()). This separates concerns, enables caching, and makes API changes easier to manage.",
      severity: "warning" as const,
      metadata: { totalApiCalls, apiComponentCount: apiComponents.length, totalComponents: components.length }
    }
  ];
}

function detectProviderStacking(components: ComponentInfo[]): ArchitectureWarning[] {
  return components
    .filter((c) => c.providers.length >= PROVIDER_STACKING_THRESHOLD)
    .map((c) => ({
      type: "provider-stacking" as const,
      title: "Provider stacking",
      message: `${c.name} nests ${c.providers.length} context providers (${c.providers.join(", ")}). Each provider triggers a re-render of its subtree.`,
      suggestion: `Reduce provider nesting in ${c.name} by combining related contexts, using a single compound provider, or lifting providers to a layout component. Consider state management libraries for complex shared state.`,
      filePath: c.filePath,
      severity: "info" as const,
      metadata: { providers: c.providers, count: c.providers.length }
    }));
}

function detectSingleResponsibilityViolation(components: ComponentInfo[]): ArchitectureWarning[] {
  return components
    .filter((c) => {
      const concerns = [
        c.routes.length > 0,
        c.apiCalls.length > 0,
        c.jsxChildren.length >= 3,
        c.providers.length > 0
      ];
      return concerns.filter(Boolean).length >= SR_VIOLATION_THRESHOLD;
    })
    .map((c) => {
      const concerns: string[] = [];
      if (c.routes.length > 0) {
        concerns.push(`defines ${c.routes.length} route(s)`);
      }
      if (c.apiCalls.length > 0) {
        concerns.push(`makes ${c.apiCalls.length} API call(s)`);
      }
      if (c.jsxChildren.length >= 3) {
        concerns.push(`renders ${c.jsxChildren.length} children`);
      }
      if (c.providers.length > 0) {
        concerns.push(`provides ${c.providers.length} context(s)`);
      }
      return {
        type: "single-responsibility-violation" as const,
        title: "Single responsibility violation",
        message: `${c.name} mixes multiple responsibilities: it ${concerns.join(", ")}. This makes the component hard to test and reason about.`,
        suggestion: `Apply the Single Responsibility Principle: extract route configuration into a router module, move API calls to a service layer, separate providers into a context module, and keep the component focused on rendering.`,
        filePath: c.filePath,
        severity: "warning" as const,
        metadata: { concerns }
      };
    });
}

function detectLowCohesion(components: ComponentInfo[]): ArchitectureWarning[] {
  return components
    .filter((c) => c.imports.length >= LOW_COHESION_IMPORT_THRESHOLD)
    .map((c) => {
      const sources = c.imports.map((i) => i.source);
      const uniqueDirs = new Set(sources.map((s) => s.split("/").slice(0, -1).join("/")));
      return {
        type: "low-cohesion" as const,
        title: "Low cohesion",
        message: `${c.name} imports from ${c.imports.length} different sources across ${uniqueDirs.size} directories. This suggests the component reaches into too many parts of the codebase.`,
        suggestion: `Group related functionality into feature modules. ${c.name} should primarily import from its own feature folder and shared utilities. Use dependency inversion (pass data via props/context) instead of direct cross-feature imports.`,
        filePath: c.filePath,
        severity: "info" as const,
        metadata: { importCount: c.imports.length, directorySpread: uniqueDirs.size, sources }
      };
    });
}

function detectMissingCodeSplitting(components: ComponentInfo[]): ArchitectureWarning[] {
  const routeComponents = new Set<string>();
  for (const c of components) {
    for (const route of c.routes) {
      if (route.component) {
        routeComponents.add(route.component);
      }
    }
  }

  if (routeComponents.size === 0) {
    return [];
  }

  return components
    .filter((c) => routeComponents.has(c.name) && c.lineCount > 100)
    .map((c) => ({
      type: "missing-code-splitting" as const,
      title: "Code splitting opportunity",
      message: `${c.name} is a route component with ${c.lineCount} lines but is likely loaded eagerly. Route-level code splitting can reduce initial bundle size.`,
      suggestion: `Wrap ${c.name} in React.lazy() with a Suspense boundary. Example: const Home = React.lazy(() => import('./pages/Home')). This defers loading until the user navigates to the route.`,
      filePath: c.filePath,
      severity: "info" as const,
      metadata: { lineCount: c.lineCount }
    }));
}

function detectTightCoupling(components: ComponentInfo[]): ArchitectureWarning[] {
  const coupling = new Map<string, number>();
  for (const c of components) {
    const totalConnections = c.imports.length + c.jsxChildren.length + c.routes.length + c.apiCalls.length;
    coupling.set(c.name, totalConnections);
  }

  return components
    .filter((c) => (coupling.get(c.name) ?? 0) >= TIGHT_COUPLING_THRESHOLD)
    .map((c) => {
      const score = coupling.get(c.name)!;
      return {
        type: "tight-coupling" as const,
        title: "Tightly coupled component",
        message: `${c.name} has a coupling score of ${score} (imports: ${c.imports.length}, children: ${c.jsxChildren.length}, routes: ${c.routes.length}, APIs: ${c.apiCalls.length}). High coupling makes changes risky.`,
        suggestion: `Decouple ${c.name} by introducing abstraction layers. Use context for shared state, extract child components, and define clear module boundaries. Aim for a coupling score below ${TIGHT_COUPLING_THRESHOLD}.`,
        filePath: c.filePath,
        severity: "warning" as const,
        metadata: { couplingScore: score, imports: c.imports.length, children: c.jsxChildren.length, routes: c.routes.length, apiCalls: c.apiCalls.length }
      };
    });
}

function scoreArchitecture(
  components: ComponentInfo[],
  warnings: ArchitectureWarning[]
): number {
  const severityPenalty: Record<string, number> = {
    "error": 18,
    "warning": 8,
    "info": 3
  };

  const typeMultiplier: Record<string, number> = {
    "circular-dependency": 1.5,
    "god-component": 1.4,
    "single-responsibility-violation": 1.3,
    "tight-coupling": 1.2,
    "large-component": 1.1,
    "high-fan-out": 1.1,
    "deep-nesting": 1.0,
    "hook-overload": 1.0,
    "api-concentration": 0.9,
    "low-cohesion": 0.9,
    "high-fan-in": 0.8,
    "provider-stacking": 0.7,
    "missing-code-splitting": 0.5,
    "dead-component": 0.6,
    "parse-error": 1.0
  };

  const penalty = warnings.reduce((total, warning) => {
    const base = severityPenalty[warning.severity] ?? 4;
    const multiplier = typeMultiplier[warning.type] ?? 1.0;
    return total + Math.round(base * multiplier);
  }, 0);
  const complexityPenalty = Math.max(0, components.length - 40);
  return Math.max(0, Math.min(100, 100 - penalty - complexityPenalty));
}
