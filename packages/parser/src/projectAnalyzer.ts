import type {
  ApiCallInfo,
  ArchitectureGraph,
  ArchitectureWarning,
  ComponentInfo,
  GraphEdge,
  GraphNode,
  ImportInfo,
  SourceFile
} from "@rav/shared";
import { extractFile } from "./astExtractors.js";
import type {
  ComponentFunctionCalls,
  DynamicImportInfo,
  FunctionDetail,
  HookDetail,
  ImportBinding,
  ReExportInfo
} from "./astExtractors.js";
import {
  buildPathIndex,
  DEFAULT_ALIASES,
  isSourceFile,
  normalizePath,
  resolveImport
} from "./pathUtils.js";
import type { ImportAliases } from "./pathUtils.js";

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

export type AnalyzeProjectOptions = {
  /**
   * Path aliases, e.g. `{ "@": "src" }`. Defaults to `{ "@": "src" }`, the
   * Vite/Next.js convention. Pass `{}` (plus your own entries) to disable
   * the default — note the default is always merged in unless overridden.
   */
  aliases?: ImportAliases;
};

type ResolvedBinding = ImportBinding & { resolvedPath?: string };
type ResolvedReExport = ReExportInfo & { resolvedSource?: string };
type ResolvedDynamicImport = DynamicImportInfo & { resolvedPath?: string };

type FileAnalysis = {
  path: string;
  components: ComponentInfo[];
  fileImports: ImportInfo[];
  bindings: ResolvedBinding[];
  dynamicImports: ResolvedDynamicImport[];
  reExports: ResolvedReExport[];
  exportAllSources: string[];
  defaultExportName?: string;
  hookDetails: HookDetail[];
  functionDetails: FunctionDetail[];
  componentCalls: ComponentFunctionCalls[];
};

/** Project-wide indexes for resolving names to components. */
type ResolutionContext = {
  componentsByFile: Map<string, ComponentInfo[]>;
  componentByKey: Map<string, ComponentInfo>;
  defaultExportByFile: Map<string, string>;
  reExportsByFile: Map<string, ResolvedReExport[]>;
  exportAllByFile: Map<string, string[]>;
  bindingsByFile: Map<string, ResolvedBinding[]>;
  /** file -> lazy local name -> dynamic import target (e.g. `Lazy` -> `./Lazy`). */
  lazyBindingsByFile: Map<
    string,
    Map<string, { resolvedPath: string; source: string }>
  >;
  /** Components loaded via dynamic import() (incl. React.lazy). */
  lazyComponentKeys: Set<string>;
  /** file -> files it imports (static, dynamic, and re-export edges). */
  fileGraph: Map<string, Set<string>>;
};

/** Components are identified by file + name — names alone collide across files. */
function componentKey(filePath: string, name: string): string {
  return `${filePath}#${name}`;
}

function componentKeyOf(component: ComponentInfo): string {
  return componentKey(component.filePath, component.name);
}

function componentNodeId(filePath: string, name: string): string {
  return `component:${componentKey(filePath, name)}`;
}

export function analyzeProject(
  files: SourceFile[],
  options: AnalyzeProjectOptions = {}
): ArchitectureGraph {
  const aliases = { ...DEFAULT_ALIASES, ...(options.aliases ?? {}) };
  const sourceFiles = files
    .map((file) => ({ ...file, path: normalizePath(file.path) }))
    .filter((file) => isSourceFile(file.path));

  const pathIndex = buildPathIndex(sourceFiles.map((file) => file.path));
  const warnings: ArchitectureWarning[] = [];
  const analyses: FileAnalysis[] = [];

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

    const resolve = (source: string): string | undefined =>
      resolveImport(file.path, source, pathIndex, aliases);

    analyses.push({
      path: file.path,
      components: result.components.map((component) => ({
        ...component,
        imports: component.imports.map((importInfo) => ({
          ...importInfo,
          resolvedPath: resolve(importInfo.source)
        }))
      })),
      fileImports: result.fileImports.map((importInfo) => ({
        ...importInfo,
        resolvedPath: resolve(importInfo.source)
      })),
      bindings: result.bindings.map((binding) => ({
        ...binding,
        resolvedPath: resolve(binding.source)
      })),
      dynamicImports: result.dynamicImports.map((dynamicImport) => ({
        ...dynamicImport,
        resolvedPath: resolve(dynamicImport.source)
      })),
      reExports: result.reExports.map((reExport) => ({
        ...reExport,
        resolvedSource: resolve(reExport.source)
      })),
      exportAllSources: result.exportAllSources
        .map((source) => resolve(source))
        .filter((resolved): resolved is string => resolved !== undefined),
      defaultExportName: result.defaultExportName,
      hookDetails: result.hookDetails,
      functionDetails: result.functionDetails,
      componentCalls: result.componentCalls
    });
  }

  const components = analyses.flatMap((analysis) => analysis.components);
  const context = buildResolutionContext(analyses, components);
  // Service-function propagation runs first so hooks that call service
  // functions inherit their API calls before hook propagation runs.
  propagateFunctionApiCalls(components, analyses, context);
  propagateHookApiCalls(components, analyses);

  warnings.push(...detectLargeComponents(components));
  warnings.push(...detectDeadComponents(components, context));
  warnings.push(...detectCircularDependencies(context));
  warnings.push(...detectGodComponents(components));
  warnings.push(...detectHighFanIn(components, context));
  warnings.push(...detectHighFanOut(components));
  warnings.push(...detectDeepNesting(components, context));
  warnings.push(...detectHookOverload(components));
  warnings.push(...detectApiConcentration(components));
  warnings.push(...detectProviderStacking(components));
  warnings.push(...detectSingleResponsibilityViolation(components));
  warnings.push(...detectLowCohesion(components));
  warnings.push(...detectMissingCodeSplitting(components, context));
  warnings.push(...detectTightCoupling(components));

  const { nodes, edges } = buildGraph(components, context);

  const metrics = {
    fileCount: sourceFiles.length,
    componentCount: components.length,
    // File-level imports, counted once per file — not once per component.
    importCount: analyses.reduce((total, analysis) => total + analysis.fileImports.length, 0),
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

function buildResolutionContext(
  analyses: FileAnalysis[],
  components: ComponentInfo[]
): ResolutionContext {
  const componentsByFile = new Map<string, ComponentInfo[]>();
  const componentByKey = new Map<string, ComponentInfo>();
  for (const component of components) {
    componentsByFile.set(component.filePath, [
      ...(componentsByFile.get(component.filePath) ?? []),
      component
    ]);
    componentByKey.set(componentKeyOf(component), component);
  }

  const defaultExportByFile = new Map<string, string>();
  const reExportsByFile = new Map<string, ResolvedReExport[]>();
  const exportAllByFile = new Map<string, string[]>();
  const bindingsByFile = new Map<string, ResolvedBinding[]>();
  const lazyBindingsByFile = new Map<
    string,
    Map<string, { resolvedPath: string; source: string }>
  >();
  const fileGraph = new Map<string, Set<string>>();

  for (const analysis of analyses) {
    if (analysis.defaultExportName) {
      defaultExportByFile.set(analysis.path, analysis.defaultExportName);
    }
    reExportsByFile.set(analysis.path, analysis.reExports);
    exportAllByFile.set(analysis.path, analysis.exportAllSources);
    bindingsByFile.set(analysis.path, analysis.bindings);

    const lazyBindings = new Map<string, { resolvedPath: string; source: string }>();
    for (const dynamicImport of analysis.dynamicImports) {
      if (dynamicImport.resolvedPath && dynamicImport.localName) {
        lazyBindings.set(dynamicImport.localName, {
          resolvedPath: dynamicImport.resolvedPath,
          source: dynamicImport.source
        });
      }
    }
    lazyBindingsByFile.set(analysis.path, lazyBindings);

    // File graph from ALL source files — not just component files — so cycles
    // passing through utility modules are visible.
    const edges = new Set<string>();
    for (const importInfo of analysis.fileImports) {
      if (importInfo.resolvedPath && importInfo.resolvedPath !== analysis.path) {
        edges.add(importInfo.resolvedPath);
      }
    }
    for (const dynamicImport of analysis.dynamicImports) {
      if (dynamicImport.resolvedPath && dynamicImport.resolvedPath !== analysis.path) {
        edges.add(dynamicImport.resolvedPath);
      }
    }
    fileGraph.set(analysis.path, edges);
  }

  const context: ResolutionContext = {
    componentsByFile,
    componentByKey,
    defaultExportByFile,
    reExportsByFile,
    exportAllByFile,
    bindingsByFile,
    lazyBindingsByFile,
    lazyComponentKeys: new Set<string>(),
    fileGraph
  };

  // A dynamically imported module's default export is loaded lazily (and is
  // therefore referenced, not dead, and already code-split).
  for (const analysis of analyses) {
    for (const dynamicImport of analysis.dynamicImports) {
      if (!dynamicImport.resolvedPath) {
        continue;
      }
      const target = resolveDefaultComponent(context, dynamicImport.resolvedPath);
      if (target) {
        context.lazyComponentKeys.add(componentKeyOf(target));
      }
    }
  }

  return context;
}

/**
 * API calls made inside a service module belong to the components that call
 * it: `urlsApi.list()` in `api/urls.api.ts` is triggered by the component
 * that calls it. Propagate each module-level function's calls (transitively,
 * through functions calling functions, across files via import bindings and
 * barrel re-exports) into its callers — components directly, and hooks first
 * so hook propagation carries them onward.
 */
function propagateFunctionApiCalls(
  components: ComponentInfo[],
  analyses: FileAnalysis[],
  context: ResolutionContext
): void {
  const defsByFile = new Map<string, Map<string, FunctionDetail>>();
  for (const analysis of analyses) {
    const defs = new Map<string, FunctionDetail>();
    for (const detail of analysis.functionDetails) {
      const existing = defs.get(detail.name);
      if (existing) {
        existing.apiCalls.push(...detail.apiCalls);
        existing.calls.push(...detail.calls);
      } else {
        defs.set(detail.name, { ...detail, calls: [...detail.calls] });
      }
    }
    defsByFile.set(analysis.path, defs);
  }
  if ([...defsByFile.values()].every((defs) => defs.size === 0)) {
    return;
  }

  /** Find a function def, following barrel re-exports (`export { X } from`,
   * `export *`). */
  function findDef(
    file: string,
    key: string,
    seen: Set<string>
  ): { file: string; key: string } | undefined {
    const marker = `${file}#${key}`;
    if (seen.has(marker)) {
      return undefined;
    }
    seen.add(marker);
    if (defsByFile.get(file)?.has(key)) {
      return { file, key };
    }
    const dot = key.indexOf(".");
    const baseName = dot === -1 ? key : key.slice(0, dot);
    const method = dot === -1 ? undefined : key.slice(dot + 1);
    for (const reExport of context.reExportsByFile.get(file) ?? []) {
      if (reExport.exportedName !== baseName || !reExport.resolvedSource) {
        continue;
      }
      const nextKey = method
        ? `${reExport.localName}.${method}`
        : reExport.localName;
      const found = findDef(reExport.resolvedSource, nextKey, seen);
      if (found) {
        return found;
      }
    }
    for (const source of context.exportAllByFile.get(file) ?? []) {
      const found = findDef(source, key, seen);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** Resolve a call as written in `fromFile` to the file + def key that
   * implements it: same-file defs first, then import bindings (translating
   * local names through aliases, e.g. `api.list` via
   * `import { urlsApi as api }` resolves to `urlsApi.list`). */
  function resolveCall(
    fromFile: string,
    callName: string
  ): { file: string; key: string } | undefined {
    if (defsByFile.get(fromFile)?.has(callName)) {
      return { file: fromFile, key: callName };
    }
    const dot = callName.indexOf(".");
    const baseName = dot === -1 ? callName : callName.slice(0, dot);
    const method = dot === -1 ? undefined : callName.slice(dot + 1);
    const binding = (context.bindingsByFile.get(fromFile) ?? []).find(
      (candidate) => candidate.localName === baseName
    );
    if (!binding?.resolvedPath) {
      return undefined;
    }
    const importedKey = method
      ? `${binding.importedName}.${method}`
      : binding.importedName;
    return findDef(binding.resolvedPath, importedKey, new Set());
  }

  // Transitive closure with a cycle guard, mirroring the hook collector.
  // Results computed while a cycle was cut are not memoized.
  const transitive = new Map<string, ApiCallInfo[]>();
  function collect(
    file: string,
    key: string,
    visiting: Set<string>
  ): { calls: ApiCallInfo[]; tainted: boolean } {
    const memoKey = `${file}#${key}`;
    const cached = transitive.get(memoKey);
    if (cached) {
      return { calls: cached, tainted: false };
    }
    if (visiting.has(memoKey)) {
      return { calls: [], tainted: true };
    }
    const def = defsByFile.get(file)?.get(key);
    if (!def) {
      return { calls: [], tainted: false };
    }
    visiting.add(memoKey);
    const calls = [...def.apiCalls];
    let tainted = false;
    for (const callee of def.calls) {
      const resolved = resolveCall(file, callee);
      if (!resolved) {
        continue;
      }
      const sub = collect(resolved.file, resolved.key, visiting);
      tainted = tainted || sub.tainted;
      calls.push(...sub.calls);
    }
    visiting.delete(memoKey);
    if (!tainted) {
      transitive.set(memoKey, calls);
    }
    return { calls, tainted };
  }

  // Hooks calling service functions inherit their API calls, so the hook
  // propagation that runs next carries them into components.
  for (const analysis of analyses) {
    for (const hook of analysis.hookDetails) {
      const seen = new Set(
        hook.apiCalls.map((call) => `${call.method}:${call.endpoint}`)
      );
      for (const callee of hook.calls) {
        const resolved = resolveCall(analysis.path, callee);
        if (!resolved) {
          continue;
        }
        for (const call of collect(resolved.file, resolved.key, new Set())
          .calls) {
          const key = `${call.method}:${call.endpoint}`;
          if (!seen.has(key)) {
            seen.add(key);
            hook.apiCalls.push(call);
          }
        }
      }
    }
  }

  const callsByComponent = new Map<string, string[]>();
  for (const analysis of analyses) {
    for (const entry of analysis.componentCalls) {
      callsByComponent.set(
        componentKey(analysis.path, entry.name),
        entry.calls
      );
    }
  }

  for (const component of components) {
    const calls = callsByComponent.get(componentKeyOf(component));
    if (!calls) {
      continue;
    }
    const seen = new Set(
      component.apiCalls.map((call) => `${call.method}:${call.endpoint}`)
    );
    for (const callee of calls) {
      const resolved = resolveCall(component.filePath, callee);
      if (!resolved) {
        continue;
      }
      for (const call of collect(resolved.file, resolved.key, new Set())
        .calls) {
        const key = `${call.method}:${call.endpoint}`;
        if (!seen.has(key)) {
          seen.add(key);
          component.apiCalls.push(call);
        }
      }
    }
  }
}

/**
 * API calls made inside a custom hook belong to the components that call the
 * hook: the component's render triggers them. Propagate each hook's calls
 * (transitively, through hooks calling hooks) into its callers.
 */
function propagateHookApiCalls(
  components: ComponentInfo[],
  analyses: FileAnalysis[]
): void {
  const hookDefs = new Map<string, { apiCalls: ApiCallInfo[]; calls: Set<string> }>();
  for (const analysis of analyses) {
    for (const hook of analysis.hookDetails) {
      const existing = hookDefs.get(hook.name) ?? { apiCalls: [], calls: new Set<string>() };
      existing.apiCalls.push(...hook.apiCalls);
      hook.hooks.forEach((called) => existing.calls.add(called));
      hookDefs.set(hook.name, existing);
    }
  }

  if (hookDefs.size === 0) {
    return;
  }

  // Transitive closure with a cycle guard. Results computed while a cycle was
  // cut are not memoized — they depend on the entry point.
  const transitive = new Map<string, ApiCallInfo[]>();
  function collect(
    name: string,
    visiting: Set<string>
  ): { calls: ApiCallInfo[]; tainted: boolean } {
    const cached = transitive.get(name);
    if (cached) {
      return { calls: cached, tainted: false };
    }
    if (visiting.has(name)) {
      return { calls: [], tainted: true };
    }
    const def = hookDefs.get(name);
    if (!def) {
      return { calls: [], tainted: false };
    }
    visiting.add(name);
    const calls = [...def.apiCalls];
    let tainted = false;
    for (const callee of def.calls) {
      const sub = collect(callee, visiting);
      tainted = tainted || sub.tainted;
      calls.push(...sub.calls);
    }
    visiting.delete(name);
    if (!tainted) {
      transitive.set(name, calls);
    }
    return { calls, tainted };
  }

  for (const component of components) {
    const seen = new Set(
      component.apiCalls.map((call) => `${call.method}:${call.endpoint}`)
    );
    for (const hook of component.hooks) {
      for (const call of collect(hook, new Set()).calls) {
        const key = `${call.method}:${call.endpoint}`;
        if (!seen.has(key)) {
          seen.add(key);
          component.apiCalls.push(call);
        }
      }
    }
  }
}

/** Resolve a named export to a component, following barrel re-exports. */
function resolveExportedComponent(
  context: ResolutionContext,
  file: string,
  exportedName: string,
  seen: Set<string> = new Set()
): ComponentInfo | undefined {
  const direct = (context.componentsByFile.get(file) ?? []).find(
    (component) => component.name === exportedName
  );
  if (direct) {
    return direct;
  }

  for (const reExport of context.reExportsByFile.get(file) ?? []) {
    if (reExport.exportedName !== exportedName || !reExport.resolvedSource) {
      continue;
    }
    const key = `${reExport.resolvedSource}#${reExport.localName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const found = resolveExportedComponent(
      context,
      reExport.resolvedSource,
      reExport.localName,
      seen
    );
    if (found) {
      return found;
    }
  }

  for (const source of context.exportAllByFile.get(file) ?? []) {
    const key = `${source}#${exportedName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const found = resolveExportedComponent(context, source, exportedName, seen);
    if (found) {
      return found;
    }
  }

  return undefined;
}

/** Resolve a module's default export to a component, if it is one. */
function resolveDefaultComponent(
  context: ResolutionContext,
  file: string
): ComponentInfo | undefined {
  const name = context.defaultExportByFile.get(file);
  if (name) {
    const direct = context.componentByKey.get(componentKey(file, name));
    if (direct) {
      return direct;
    }
  }
  // Default re-exported from another module: `export { Foo as default }`.
  return resolveExportedComponent(context, file, "default");
}

/** Resolve an import binding to the component it imports, if it is one. */
function resolveBindingTarget(
  context: ResolutionContext,
  binding: ResolvedBinding
): ComponentInfo | undefined {
  if (!binding.resolvedPath) {
    return undefined;
  }
  if (binding.kind === "default") {
    return resolveDefaultComponent(context, binding.resolvedPath);
  }
  if (binding.kind === "named") {
    return resolveExportedComponent(context, binding.resolvedPath, binding.importedName);
  }
  // Namespace imports (`import * as ns`) have no single target component.
  return undefined;
}

/**
 * Resolve a name used as a JSX element (or route component) in a file to the
 * component it refers to: a component defined in the same file, an imported
 * component (via the file's import bindings), or a lazy-loaded component.
 * Returns `undefined` for library components (e.g. `<Routes/>`, `<Loader2/>`).
 */
function resolveJsxChild(
  context: ResolutionContext,
  name: string,
  fromComponent: ComponentInfo
): ComponentInfo | undefined {
  const candidates = [name];
  // Route components can be member expressions (`<Layout.Home/>`); try the
  // leaf name as well.
  if (name.includes(".")) {
    candidates.push(name.split(".").at(-1) ?? name);
  }

  for (const candidate of candidates) {
    const local = (context.componentsByFile.get(fromComponent.filePath) ?? []).find(
      (component) => component.name === candidate
    );
    if (local) {
      return local;
    }

    const binding = (context.bindingsByFile.get(fromComponent.filePath) ?? []).find(
      (entry) => entry.localName === candidate
    );
    if (binding) {
      const target = resolveBindingTarget(context, binding);
      if (target) {
        return target;
      }
    }

    const lazyBinding = context.lazyBindingsByFile
      .get(fromComponent.filePath)
      ?.get(candidate);
    if (lazyBinding) {
      const target = resolveDefaultComponent(context, lazyBinding.resolvedPath);
      if (target) {
        return target;
      }
    }
  }

  return undefined;
}

function buildGraph(
  components: ComponentInfo[],
  context: ResolutionContext
): Pick<ArchitectureGraph, "nodes" | "edges"> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  for (const component of components) {
    const selfId = componentNodeId(component.filePath, component.name);
    upsertNode(nodes, {
      id: selfId,
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
      const target = resolveJsxChild(context, child, component);
      if (target) {
        const targetId = componentNodeId(target.filePath, target.name);
        upsertNode(nodes, {
          id: targetId,
          label: target.name,
          kind: "component",
          filePath: target.filePath
        });
        addEdge(edges, selfId, targetId, "jsx", undefined, {
          props: component.propsToChildren[child] ?? []
        });
      } else {
        const externalId = `external:${child}`;
        upsertNode(nodes, {
          id: externalId,
          label: child,
          kind: "external"
        });
        addEdge(edges, selfId, externalId, "jsx", undefined, {
          props: component.propsToChildren[child] ?? []
        });
      }
    }

    // Import edges follow the component's used bindings, so each edge points
    // at the component actually imported — not every component in the file.
    const usedNames = new Set(
      component.imports.flatMap((importInfo) => importInfo.importedNames)
    );
    for (const binding of context.bindingsByFile.get(component.filePath) ?? []) {
      if (!usedNames.has(binding.localName)) {
        continue;
      }

      if (!binding.resolvedPath) {
        const externalId = `external:${binding.source}`;
        upsertNode(nodes, {
          id: externalId,
          label: binding.source,
          kind: "external"
        });
        addEdge(edges, selfId, externalId, "import");
        continue;
      }

      const target = resolveBindingTarget(context, binding);
      if (target) {
        addEdge(
          edges,
          selfId,
          componentNodeId(target.filePath, target.name),
          "import",
          binding.source
        );
      } else {
        // Resolved to a local module with no matching component (utils, API
        // client, constants): a file node, not an external dependency.
        const fileId = `file:${binding.resolvedPath}`;
        upsertNode(nodes, {
          id: fileId,
          label: binding.resolvedPath,
          kind: "file",
          filePath: binding.resolvedPath
        });
        addEdge(edges, selfId, fileId, "import", binding.source);
      }
    }

    // Dynamic imports (React.lazy): an import edge to the lazily loaded
    // component, so the imports view shows the dependency too.
    for (const [localName, lazyBinding] of context.lazyBindingsByFile.get(
      component.filePath
    ) ?? []) {
      if (!component.jsxChildren.includes(localName)) {
        continue;
      }
      const target = resolveDefaultComponent(context, lazyBinding.resolvedPath);
      if (target) {
        addEdge(
          edges,
          selfId,
          componentNodeId(target.filePath, target.name),
          "import",
          lazyBinding.source
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
      addEdge(edges, selfId, routeId, "route", route.component);

      if (route.component) {
        const target = resolveJsxChild(context, route.component, component);
        if (target) {
          const targetId = componentNodeId(target.filePath, target.name);
          upsertNode(nodes, {
            id: targetId,
            label: target.name,
            kind: "component",
            filePath: target.filePath
          });
          addEdge(edges, routeId, targetId, "route");
        } else {
          const externalId = `external:${route.component}`;
          upsertNode(nodes, {
            id: externalId,
            label: route.component,
            kind: "external"
          });
          addEdge(edges, routeId, externalId, "route");
        }
      }
    }

    for (const hook of component.hooks) {
      const hookId = `hook:${hook}`;
      upsertNode(nodes, { id: hookId, label: hook, kind: "hook" });
      addEdge(edges, selfId, hookId, "hook");
    }

    for (const provider of component.providers) {
      const providerId = `provider:${provider}`;
      upsertNode(nodes, { id: providerId, label: provider, kind: "provider" });
      addEdge(edges, selfId, providerId, "provider");
    }

    for (const apiCall of component.apiCalls) {
      const apiId = `api:${apiCall.method}:${apiCall.endpoint}`;
      upsertNode(nodes, {
        id: apiId,
        label: `${apiCall.method} ${apiCall.endpoint}`,
        kind: "api",
        metadata: apiCall
      });
      addEdge(edges, selfId, apiId, "api");
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()]
  };
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

function detectDeadComponents(
  components: ComponentInfo[],
  context: ResolutionContext
): ArchitectureWarning[] {
  const referenced = new Set<string>(context.lazyComponentKeys);
  const imported = new Set<string>();

  for (const component of components) {
    for (const child of component.jsxChildren) {
      const target = resolveJsxChild(context, child, component);
      if (target) {
        referenced.add(componentKeyOf(target));
      }
    }
    for (const route of component.routes) {
      if (route.component) {
        const target = resolveJsxChild(context, route.component, component);
        if (target) {
          referenced.add(componentKeyOf(target));
        }
      }
    }
  }

  // A component imported anywhere counts as used — "possibly unused" is an
  // info-level hint, so err on the side of fewer false positives.
  for (const bindings of context.bindingsByFile.values()) {
    for (const binding of bindings) {
      const target = resolveBindingTarget(context, binding);
      if (target) {
        imported.add(componentKeyOf(target));
      }
    }
  }

  return components
    .filter((component) => {
      const rootLike = ["App", "Root", "Main"].includes(component.name);
      const key = componentKeyOf(component);
      return !rootLike && !referenced.has(key) && !imported.has(key);
    })
    .map((component) => ({
      type: "dead-component",
      title: "Possibly unused component",
      message: `${component.name} was not referenced by JSX, routes, or imports in the analyzed files.`,
      filePath: component.filePath,
      severity: "info"
    }));
}

function detectCircularDependencies(context: ResolutionContext): ArchitectureWarning[] {
  const fileGraph = context.fileGraph;
  const warnings: ArchitectureWarning[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function visit(file: string, trail: string[]): void {
    if (stack.has(file)) {
      const cycleStart = trail.indexOf(file);
      // `trail` already ends with `file` (appended by the caller), so slicing
      // alone closes the cycle — appending `file` again would duplicate it.
      const cycle = trail.slice(cycleStart);
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

function detectHighFanIn(
  components: ComponentInfo[],
  context: ResolutionContext
): ArchitectureWarning[] {
  const fanIn = new Map<string, number>();
  const countUse = (component: ComponentInfo, name: string): void => {
    const target = resolveJsxChild(context, name, component);
    if (target) {
      const key = componentKeyOf(target);
      fanIn.set(key, (fanIn.get(key) ?? 0) + 1);
    }
  };

  for (const c of components) {
    for (const child of c.jsxChildren) {
      countUse(c, child);
    }
    for (const route of c.routes) {
      if (route.component) {
        countUse(c, route.component);
      }
    }
  }

  return components
    .filter((c) => (fanIn.get(componentKeyOf(c)) ?? 0) >= HIGH_FAN_IN_THRESHOLD)
    .map((c) => {
      const count = fanIn.get(componentKeyOf(c))!;
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

function detectDeepNesting(
  components: ComponentInfo[],
  context: ResolutionContext
): ArchitectureWarning[] {
  const childrenByKey = new Map<string, string[]>();
  const hasParent = new Set<string>();

  for (const c of components) {
    const children: string[] = [];
    for (const child of c.jsxChildren) {
      const target = resolveJsxChild(context, child, c);
      if (target) {
        const childKey = componentKeyOf(target);
        children.push(childKey);
        hasParent.add(childKey);
      }
    }
    childrenByKey.set(componentKeyOf(c), children);
  }

  // One warning per nesting chain, at its root — not one per component in the
  // chain. A pure cycle has no roots; evaluate a single representative.
  const roots = components
    .map((component) => componentKeyOf(component))
    .filter((key) => !hasParent.has(key));
  const seeds =
    roots.length > 0
      ? roots
      : components.length > 0
        ? [componentKeyOf(components[0])]
        : [];

  // Longest chain from a node, with a cycle guard. Results computed while a
  // cycle was cut are not memoized — they depend on the entry point.
  const memo = new Map<string, { depth: number; deepest: string }>();
  function longestChain(
    key: string,
    visiting: Set<string>
  ): { depth: number; deepest: string; tainted: boolean } {
    const cached = memo.get(key);
    if (cached) {
      return { ...cached, tainted: false };
    }
    if (visiting.has(key)) {
      return { depth: 0, deepest: key, tainted: true };
    }
    visiting.add(key);
    let best = { depth: 1, deepest: key };
    let tainted = false;
    for (const child of childrenByKey.get(key) ?? []) {
      const sub = longestChain(child, visiting);
      tainted = tainted || sub.tainted;
      if (1 + sub.depth > best.depth) {
        best = { depth: 1 + sub.depth, deepest: sub.deepest };
      }
    }
    visiting.delete(key);
    if (!tainted) {
      memo.set(key, best);
    }
    return { ...best, tainted };
  }

  const warnings: ArchitectureWarning[] = [];
  for (const seed of seeds) {
    const { depth, deepest } = longestChain(seed, new Set());
    if (depth < DEEP_NESTING_THRESHOLD) {
      continue;
    }
    const root = context.componentByKey.get(seed);
    const deepestComponent = context.componentByKey.get(deepest);
    if (!root) {
      continue;
    }
    warnings.push({
      type: "deep-nesting" as const,
      title: "Deep component nesting",
      message: `${root.name} starts a component chain ${depth} levels deep (deepest: ${deepestComponent?.name ?? deepest}). Deep nesting increases render complexity and makes prop drilling likely.`,
      suggestion: `Flatten the component tree around ${root.name}. Consider using React Context for shared state, or restructure layout components to reduce nesting depth.`,
      filePath: root.filePath,
      severity: "warning" as const,
      metadata: { depth, deepest: deepestComponent?.name ?? deepest }
    });
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
  const sorted = [...apiComponents].sort((a, b) => b.apiCalls.length - a.apiCalls.length);

  // A single component holding every API call is the MOST concentrated case,
  // not the absence of one.
  if (apiComponents.length === 1) {
    if (totalApiCalls < GOD_COMPONENT_API_CALLS) {
      return [];
    }
    const only = sorted[0];
    return [
      {
        type: "api-concentration" as const,
        title: "API calls concentrated in one component",
        message: `All ${totalApiCalls} API calls live in ${only.name}. A single component owning every request becomes a bottleneck for caching, error handling, and testing.`,
        suggestion: "Centralize API calls into a dedicated service layer or data-fetching hooks (e.g., useUsers(), useAuth()). This separates concerns, enables caching, and makes API changes easier to manage.",
        severity: "warning" as const,
        metadata: { totalApiCalls, apiComponentCount: 1, totalComponents: components.length }
      }
    ];
  }

  const ratio = apiComponents.length / (components.length || 1);
  if (ratio > API_CONCENTRATION_RATIO) {
    return [];
  }

  const heaviest = sorted.slice(0, 3);

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

function detectMissingCodeSplitting(
  components: ComponentInfo[],
  context: ResolutionContext
): ArchitectureWarning[] {
  const routeComponents = new Set<string>();
  for (const c of components) {
    for (const route of c.routes) {
      if (route.component) {
        const target = resolveJsxChild(context, route.component, c);
        if (target) {
          routeComponents.add(componentKeyOf(target));
        }
      }
    }
  }

  if (routeComponents.size === 0) {
    return [];
  }

  return components
    .filter(
      (c) =>
        routeComponents.has(componentKeyOf(c)) &&
        c.lineCount > 100 &&
        // Already loaded via React.lazy() / dynamic import() — splitting
        // is in place, so there is nothing to flag.
        !context.lazyComponentKeys.has(componentKeyOf(c))
    )
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
    coupling.set(componentKeyOf(c), totalConnections);
  }

  return components
    .filter((c) => (coupling.get(componentKeyOf(c)) ?? 0) >= TIGHT_COUPLING_THRESHOLD)
    .map((c) => {
      const score = coupling.get(componentKeyOf(c))!;
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
  // No components, nothing to score — an empty project is not a perfect one.
  if (components.length === 0) {
    return 0;
  }

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

  // Normalize by project size: the score reflects warning DENSITY (average
  // penalty per component), so large projects are not punished for existing.
  // ~25 points per component (e.g. every component a god component) scores 0;
  // one average warning per component scores ~68. There is no raw size
  // penalty — component count is not a defect.
  const density = penalty / components.length;
  return Math.max(0, Math.min(100, Math.round(100 - density * 4)));
}
