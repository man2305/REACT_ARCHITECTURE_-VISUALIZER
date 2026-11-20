import { parse } from "@babel/parser";
import traverseModule, { NodePath } from "@babel/traverse";
import type {
  ApiCallInfo,
  ComponentInfo,
  ImportInfo,
  RouteInfo
} from "@rav/shared";
import type {
  ArrowFunctionExpression,
  CallExpression,
  ExportDefaultDeclaration,
  ExportSpecifier,
  Expression,
  FunctionExpression,
  JSXAttribute,
  JSXElement,
  JSXExpressionContainer,
  JSXIdentifier,
  JSXMemberExpression,
  JSXNamespacedName,
  JSXSpreadAttribute,
  Node,
  VariableDeclarator
} from "@babel/types";

/** A single imported binding, with enough detail to resolve it precisely. */
export type ImportBinding = {
  source: string;
  /** Local name in the importing file. */
  localName: string;
  /** Exported name in the source module: `"default"`, `"*"` or a named export. */
  importedName: string;
  kind: "default" | "named" | "namespace";
};

/** A dynamic `import()` call. `localName` is set when it is assigned to a
 * variable (e.g. `const Lazy = React.lazy(() => import("./Lazy"))`). */
export type DynamicImportInfo = {
  source: string;
  localName?: string;
  /** True when wrapped in `React.lazy()` / `lazy()`. */
  lazy: boolean;
};

/** A re-export: `export { A as B } from "./x"` (or `export { A as default }`). */
export type ReExportInfo = {
  exportedName: string;
  localName: string;
  source: string;
};

/** API calls and hook calls found inside a custom hook function, so they can
 * be propagated to the components that call the hook. */
export type HookDetail = {
  name: string;
  apiCalls: ApiCallInfo[];
  hooks: string[];
  /** Service functions this hook calls (same naming as FunctionDetail.name). */
  calls: string[];
};

/** API calls made inside a module-level function (service/API module or
 * helper), so they can be propagated to the components that call it. */
export type FunctionDetail = {
  /** `getUrls` for a plain function, `urlsApi.list` for an object method,
   * `default.list` for a default-exported object's method. */
  name: string;
  apiCalls: ApiCallInfo[];
  /** Other module-level functions this one calls (same naming scheme). */
  calls: string[];
};

/** Service-function calls made inside one component. */
export type ComponentFunctionCalls = {
  name: string;
  calls: string[];
};

export type ExtractedFile = {
  components: ComponentInfo[];
  /** All file-level imports (including re-export sources). */
  fileImports: ImportInfo[];
  bindings: ImportBinding[];
  dynamicImports: DynamicImportInfo[];
  reExports: ReExportInfo[];
  exportAllSources: string[];
  /** Name of the default-exported component, when the file has one. */
  defaultExportName?: string;
  hookDetails: HookDetail[];
  functionDetails: FunctionDetail[];
  componentCalls: ComponentFunctionCalls[];
  parseError?: string;
};

type MutableComponent = Omit<ComponentInfo, "jsxChildren" | "hooks" | "providers"> & {
  jsxChildren: Set<string>;
  hooks: Set<string>;
  providers: Set<string>;
  /** Defining AST path, used for per-component import attribution. */
  defPath?: NodePath<Node>;
};

type MutableHookDetail = {
  name: string;
  apiCalls: ApiCallInfo[];
  hooks: Set<string>;
  calls: Set<string>;
};

type MutableFunctionDetail = {
  name: string;
  apiCalls: ApiCallInfo[];
  calls: Set<string>;
};

const PARSER_PLUGINS = [
  "jsx",
  "typescript",
  "classProperties",
  "decorators-legacy",
  "dynamicImport",
  "importMeta"
] as const;

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options"
]);

const HOC_WRAPPERS = new Set(["memo", "forwardRef", "observer"]);

const traverse = (
  "default" in traverseModule ? traverseModule.default : traverseModule
) as typeof traverseModule;

export function extractFile(path: string, content: string): ExtractedFile {
  const fileLineCount =
    content === ""
      ? 0
      : content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
  const fileImports: ImportInfo[] = [];
  const bindings: ImportBinding[] = [];
  const dynamicImports: DynamicImportInfo[] = [];
  const reExports: ReExportInfo[] = [];
  const exportAllSources: string[] = [];
  const componentMap = new Map<string, MutableComponent>();
  const hookDetailMap = new Map<string, MutableHookDetail>();
  const functionDetailMap = new Map<string, MutableFunctionDetail>();
  const componentCallsMap = new Map<string, Set<string>>();
  const axiosInstances = new Set<string>();
  const exportedNames = new Set<string>();
  let defaultExportName: string | undefined;
  let parseError: string | undefined;

  function ensureComponent(
    name: string,
    opts: {
      exported?: boolean;
      lineCount?: number;
      defPath?: NodePath<Node>;
    } = {}
  ): MutableComponent {
    const existing = componentMap.get(name);
    if (existing) {
      if (opts.exported) {
        existing.exported = true;
      }
      // Prefer a precise declaration span over the file-level fallback.
      if (existing.lineCount === fileLineCount && opts.lineCount !== undefined) {
        existing.lineCount = opts.lineCount;
      }
      if (!existing.defPath && opts.defPath) {
        existing.defPath = opts.defPath;
      }
      return existing;
    }

    const component: MutableComponent = {
      name,
      filePath: path,
      lineCount: opts.lineCount ?? fileLineCount,
      imports: [],
      jsxChildren: new Set<string>(),
      hooks: new Set<string>(),
      routes: [],
      apiCalls: [],
      providers: new Set<string>(),
      propsToChildren: {},
      exported: opts.exported ?? false,
      defPath: opts.defPath
    };
    componentMap.set(name, component);
    return component;
  }

  function ensureHookDetail(name: string): MutableHookDetail {
    const existing = hookDetailMap.get(name);
    if (existing) {
      return existing;
    }
    const detail: MutableHookDetail = {
      name,
      apiCalls: [],
      hooks: new Set<string>(),
      calls: new Set<string>()
    };
    hookDetailMap.set(name, detail);
    return detail;
  }

  function ensureFunctionDetail(name: string): MutableFunctionDetail {
    const existing = functionDetailMap.get(name);
    if (existing) {
      return existing;
    }
    const detail: MutableFunctionDetail = {
      name,
      apiCalls: [],
      calls: new Set<string>()
    };
    functionDetailMap.set(name, detail);
    return detail;
  }

  function ensureComponentCalls(name: string): Set<string> {
    const existing = componentCallsMap.get(name);
    if (existing) {
      return existing;
    }
    const calls = new Set<string>();
    componentCallsMap.set(name, calls);
    return calls;
  }

  try {
    const ast = parse(content, {
      sourceType: "module",
      errorRecovery: true,
      plugins: [...PARSER_PLUGINS]
    });

    // `errorRecovery` collects recoverable syntax errors instead of throwing.
    // They must be surfaced — otherwise a broken file yields partial, wrong
    // results with no warning at all.
    if (ast.errors && ast.errors.length > 0) {
      parseError = ast.errors.map((error) => error.message).join("; ");
    }

    // Imported local names, collected up front so the API-call heuristic can
    // tell an imported HTTP client (`api.get(...)`) from a local object —
    // independent of traversal order.
    const importedLocalNames = new Set<string>();
    for (const statement of ast.program.body) {
      if (statement.type !== "ImportDeclaration" || statement.importKind === "type") {
        continue;
      }
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") {
          continue;
        }
        importedLocalNames.add(specifier.local.name);
      }
    }

    traverse(ast, {
      ImportDeclaration(importPath) {
        const node = importPath.node;
        // Type-only imports are not runtime dependencies.
        if (node.importKind === "type") {
          return;
        }

        const importedNames: string[] = [];
        for (const specifier of node.specifiers) {
          // Per-specifier `import { type Foo }` (only ImportSpecifier has one).
          if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") {
            continue;
          }
          importedNames.push(specifier.local.name);
          if (specifier.type === "ImportDefaultSpecifier") {
            bindings.push({
              source: node.source.value,
              localName: specifier.local.name,
              importedName: "default",
              kind: "default"
            });
          } else if (specifier.type === "ImportNamespaceSpecifier") {
            bindings.push({
              source: node.source.value,
              localName: specifier.local.name,
              importedName: "*",
              kind: "namespace"
            });
          } else {
            bindings.push({
              source: node.source.value,
              localName: specifier.local.name,
              importedName:
                specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : specifier.imported.value,
              kind: "named"
            });
          }
        }

        fileImports.push({ source: node.source.value, importedNames });
      },

      ExportNamedDeclaration(exportPath) {
        const node = exportPath.node;

        if (node.source) {
          // Re-export: `export { A } from "./x"`, `export { A as B } from "./x"`.
          const source = node.source.value;
          const reExportedNames: string[] = [];
          for (const specifier of node.specifiers) {
            if (specifier.type === "ExportSpecifier") {
              reExports.push({
                exportedName: getExportedName(specifier),
                localName: specifier.local.name,
                source
              });
              reExportedNames.push(specifier.local.name);
            }
          }
          fileImports.push({ source, importedNames: reExportedNames });
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type !== "ExportSpecifier") {
            continue;
          }
          const exportedName = getExportedName(specifier);
          if (exportedName === "default") {
            defaultExportName = specifier.local.name;
          } else {
            // The declaration may come later in the file, so resolve the
            // exported flag in a post-pass.
            exportedNames.add(specifier.local.name);
          }
        }
      },

      ExportAllDeclaration(exportPath) {
        const source = exportPath.node.source.value;
        exportAllSources.push(source);
        fileImports.push({ source, importedNames: [] });
      },

      FunctionDeclaration(functionPath) {
        const name = functionPath.node.id?.name;
        if (name && isComponentName(name)) {
          ensureComponent(name, {
            exported: isExported(functionPath),
            lineCount: locLineCount(functionPath.node.loc),
            defPath: functionPath
          });
        }
      },

      VariableDeclarator(variablePath) {
        const node = variablePath.node;
        const name =
          node.id.type === "Identifier" ? node.id.name : undefined;

        // `const api = axios.create(...)` — record `api` as an axios instance
        // so `api.get(...)` is recognised as an API call.
        if (
          name &&
          node.init?.type === "CallExpression" &&
          isAxiosCreate(node.init)
        ) {
          axiosInstances.add(name);
        }

        if (name && isComponentName(name) && isFunctionLikeVariable(node)) {
          ensureComponent(name, {
            exported: isExported(variablePath),
            lineCount: locLineCount(node.loc),
            defPath: variablePath
          });
        }
      },

      ClassDeclaration(classPath) {
        const name = classPath.node.id?.name;
        if (
          name &&
          isComponentName(name) &&
          isReactComponentSuperClass(classPath.node.superClass)
        ) {
          ensureComponent(name, {
            exported: isExported(classPath),
            lineCount: locLineCount(classPath.node.loc),
            defPath: classPath
          });
        }
      },

      ExportDefaultDeclaration(exportPath) {
        const declaration = exportPath.node.declaration;

        if (declaration.type === "FunctionDeclaration") {
          const name = declaration.id?.name ?? "DefaultComponent";
          if (isComponentName(name)) {
            defaultExportName = declaration.id?.name;
            ensureComponent(name, {
              exported: true,
              lineCount: locLineCount(declaration.loc),
              defPath: exportPath.get("declaration") as NodePath<Node>
            });
          }
          return;
        }

        if (declaration.type === "Identifier") {
          // `export default Foo;` — Foo must already be declared in this file.
          // Only record the default export; never create a phantom component
          // for an imported name.
          defaultExportName = declaration.name;
        }
      },

      JSXOpeningElement(jsxPath) {
        const component = findNearestComponent(jsxPath, componentMap);
        if (!component) {
          return;
        }

        const elementName = getJsxName(jsxPath.node.name);
        if (!elementName) {
          return;
        }

        if (elementName.endsWith("Provider")) {
          component.providers.add(elementName);
        }

        if (elementName === "Route") {
          const route = extractRoute(jsxPath.node.attributes);
          if (route) {
            component.routes.push(route);
          }
          return;
        }

        const leafName = elementName.split(".").at(-1) ?? elementName;
        if (isComponentName(leafName) && leafName !== component.name) {
          component.jsxChildren.add(leafName);
          const propNames = jsxPath.node.attributes
            .filter((attribute): attribute is JSXAttribute => attribute.type === "JSXAttribute")
            .map((attribute) => getJsxName(attribute.name))
            .filter((propName): propName is string => Boolean(propName));

          if (propNames.length > 0) {
            component.propsToChildren[leafName] = [
              ...(component.propsToChildren[leafName] ?? []),
              ...propNames
            ];
          }
        }
      },

      CallExpression(callPath) {
        const node = callPath.node;

        // Dynamic import() — recorded regardless of any enclosing component.
        if (node.callee.type === "Import") {
          recordDynamicImport(callPath);
          return;
        }

        const hookName = getHookName(node);
        const apiCall = getApiCall(node, axiosInstances, importedLocalNames);
        // A plain call to another function (`getUrls()`, `urlsApi.list()`).
        // Hook calls and API calls have their own attribution and are not
        // also recorded as function calls.
        const callName =
          !hookName && !apiCall ? getFunctionCallName(node) : undefined;

        const component = findNearestComponent(callPath, componentMap);
        if (component) {
          if (hookName) {
            component.hooks.add(hookName);
          }
          if (apiCall) {
            component.apiCalls.push({
              ...apiCall,
              line: node.loc?.start.line
            });
          }
          if (callName) {
            ensureComponentCalls(component.name).add(callName);
          }
          return;
        }

        // Calls inside a custom hook body are attributed to the hook, so the
        // analyzer can propagate them to the components that call the hook.
        const hook = findNearestHook(callPath);
        if (hook) {
          const detail = ensureHookDetail(hook);
          if (hookName) {
            detail.hooks.add(hookName);
          }
          if (apiCall) {
            detail.apiCalls.push({
              ...apiCall,
              line: node.loc?.start.line
            });
          }
          if (callName) {
            detail.calls.add(callName);
          }
          return;
        }

        // Calls inside a module-level function (service/API module, helper)
        // are attributed to that function, so the analyzer can propagate them
        // to the components that call it.
        const fn = findNearestModuleFunction(callPath);
        if (fn) {
          const detail = ensureFunctionDetail(fn);
          if (apiCall) {
            detail.apiCalls.push({
              ...apiCall,
              line: node.loc?.start.line
            });
          }
          if (callName) {
            detail.calls.add(callName);
          }
        }
      }
    });

    function recordDynamicImport(callPath: NodePath<CallExpression>): void {
      const source = getStringExpression(callPath.node.arguments[0]);
      if (!source) {
        return;
      }

      let localName: string | undefined;
      let lazy = false;
      let current: NodePath<Node> | null = callPath.parentPath;
      while (current) {
        if (current.isCallExpression() && isLazyCall(current.node)) {
          lazy = true;
        }
        if (current.isVariableDeclarator()) {
          if (current.node.id.type === "Identifier") {
            localName = current.node.id.name;
          }
          break;
        }
        current = current.parentPath;
      }

      dynamicImports.push({ source, localName, lazy });
    }

    // Post-pass: resolve exported flags that could not be determined during
    // traversal (specifier lists, `export default Foo;`).
    for (const name of exportedNames) {
      const component = componentMap.get(name);
      if (component) {
        component.exported = true;
      }
    }
    if (defaultExportName) {
      const component = componentMap.get(defaultExportName);
      if (component) {
        component.exported = true;
      }
    }

    // Post-pass: attribute imports per component by usage. An import belongs
    // to a component only if the component's body references one of its local
    // names (as a value, a hook call, or a JSX element). File-level imports
    // stay in `fileImports` for the file graph and metrics.
    for (const component of componentMap.values()) {
      component.imports = attributeImports(component, fileImports);
    }

    return {
      components: [...componentMap.values()].map((component) => ({
        name: component.name,
        filePath: component.filePath,
        lineCount: component.lineCount,
        imports: component.imports,
        jsxChildren: [...component.jsxChildren].sort(),
        hooks: [...component.hooks].sort(),
        routes: component.routes,
        apiCalls: component.apiCalls,
        providers: [...component.providers].sort(),
        propsToChildren: component.propsToChildren,
        exported: component.exported
      })),
      fileImports,
      bindings,
      dynamicImports,
      reExports,
      exportAllSources,
      defaultExportName,
      hookDetails: [...hookDetailMap.values()].map((detail) => ({
        name: detail.name,
        apiCalls: detail.apiCalls,
        hooks: [...detail.hooks].sort(),
        calls: [...detail.calls].sort()
      })),
      functionDetails: [...functionDetailMap.values()].map((detail) => ({
        name: detail.name,
        apiCalls: detail.apiCalls,
        calls: [...detail.calls].sort()
      })),
      componentCalls: [...componentCallsMap.entries()].map(([name, calls]) => ({
        name,
        calls: [...calls].sort()
      })),
      parseError
    };
  } catch (error) {
    return {
      components: [],
      fileImports: [],
      bindings: [],
      dynamicImports: [],
      reExports: [],
      exportAllSources: [],
      hookDetails: [],
      functionDetails: [],
      componentCalls: [],
      parseError:
        parseError ?? (error instanceof Error ? error.message : "Unknown parse error")
    };
  }

  function attributeImports(
    component: MutableComponent,
    allImports: ImportInfo[]
  ): ImportInfo[] {
    const used = new Set<string>();

    // Names already collected during traversal (JSX children, hooks,
    // providers, route components).
    component.jsxChildren.forEach((name) => used.add(name));
    component.hooks.forEach((name) => used.add(name));
    component.providers.forEach((name) => used.add(name));
    component.routes.forEach((route) => {
      if (route.component) {
        used.add(route.component);
      }
    });

    // Referenced identifiers inside the component's own definition, including
    // nested callbacks (useEffect handlers, .map callbacks, event handlers).
    if (component.defPath) {
      component.defPath.traverse({
        Identifier(idPath) {
          if (idPath.isReferencedIdentifier()) {
            used.add(idPath.node.name);
          }
        },
        JSXIdentifier(jsxPath) {
          // Element names only — attribute names (`title=` in `<div title=…/>`)
          // are not references to imports.
          if (jsxPath.parentPath?.isJSXAttribute()) {
            return;
          }
          used.add(jsxPath.node.name);
        }
      });
    }

    return allImports.filter((importInfo) =>
      importInfo.importedNames.some((name) => used.has(name))
    );
  }
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}

function locLineCount(
  loc: { start: { line: number }; end: { line: number } } | null | undefined
): number | undefined {
  if (!loc) {
    return undefined;
  }
  return loc.end.line - loc.start.line + 1;
}

/** Unwrap `memo(...)` / `forwardRef(...)` / `observer(...)` to the inner
 * function, recursing through nested wrappers. Returns `null` for any other
 * call expression. */
function unwrapHocInitializer(
  node: Expression | null | undefined
): Expression | null | undefined {
  let current = node;
  while (current?.type === "CallExpression") {
    const calleeName = getCalleeName(current.callee);
    if (calleeName && HOC_WRAPPERS.has(calleeName)) {
      current = current.arguments[0] as Expression | undefined;
      continue;
    }
    return null;
  }
  return current;
}

function getCalleeName(
  callee: CallExpression["callee"]
): string | undefined {
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "React" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
}

function isFunctionLikeVariable(node: VariableDeclarator): boolean {
  const init = unwrapHocInitializer(node.init);
  return init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression";
}

function isReactComponentSuperClass(superClass: Node | null | undefined): boolean {
  if (!superClass) {
    return false;
  }
  if (superClass.type === "Identifier") {
    return superClass.name === "Component" || superClass.name === "PureComponent";
  }
  if (
    superClass.type === "MemberExpression" &&
    !superClass.computed &&
    superClass.object.type === "Identifier" &&
    superClass.object.name === "React" &&
    superClass.property.type === "Identifier"
  ) {
    return (
      superClass.property.name === "Component" ||
      superClass.property.name === "PureComponent"
    );
  }
  return false;
}

function isExported(path: NodePath<Node>): boolean {
  const parent = path.parentPath;
  if (!parent) {
    return false;
  }
  if (parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) {
    return true;
  }
  // `export const Foo = ...`: VariableDeclarator -> VariableDeclaration ->
  // ExportNamedDeclaration.
  return parent.parentPath?.isExportNamedDeclaration() ?? false;
}

function getExportedName(specifier: ExportSpecifier): string {
  return specifier.exported.type === "Identifier"
    ? specifier.exported.name
    : specifier.exported.value;
}

/**
 * Walk up the ancestor chain to the enclosing component. Unlike
 * `getFunctionParent()`, this sees through nested callbacks (`useEffect`,
 * `.map`, event handlers), class methods (`render()`), and HOC wrappers, so
 * JSX and API calls inside them are attributed to the component they belong
 * to instead of being dropped.
 */
function findNearestComponent(
  path: NodePath<Node>,
  components: Map<string, MutableComponent>
): MutableComponent | undefined {
  let current: NodePath<Node> | null = path;
  while (current) {
    const node = current.node;
    if (
      node.type === "FunctionDeclaration" &&
      node.id &&
      components.has(node.id.name)
    ) {
      return components.get(node.id.name);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      components.has(node.id.name)
    ) {
      return components.get(node.id.name);
    }
    if (
      node.type === "ClassDeclaration" &&
      node.id &&
      components.has(node.id.name)
    ) {
      return components.get(node.id.name);
    }
    current = current.parentPath;
  }
  return undefined;
}

/**
 * Local name of the function being called: `getUrls` for a plain call,
 * `urlsApi.list` for a member call. Returns undefined for computed members,
 * chained calls, and non-identifier callees.
 */
function getFunctionCallName(node: CallExpression): string | undefined {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.property.type === "Identifier"
  ) {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return undefined;
}

function isFunctionNode(
  node: Node
): node is ArrowFunctionExpression | FunctionExpression {
  return (
    node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression"
  );
}

/** True when the declaration sits directly in the module body (or in an
 * `export` statement at the module body). */
function isModuleLevelDeclaration(path: NodePath<Node>): boolean {
  const parent = path.parentPath;
  if (!parent) {
    return false;
  }
  if (parent.isProgram()) {
    return true;
  }
  if (parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) {
    return parent.parentPath?.isProgram() ?? false;
  }
  return false;
}

/** True when the declarator's `const`/`let`/`var` sits at the module body. */
function isModuleLevelDeclarator(path: NodePath<Node>): boolean {
  const parent = path.parentPath;
  if (!parent?.isVariableDeclaration()) {
    return false;
  }
  const grandparent = parent.parentPath;
  if (!grandparent) {
    return false;
  }
  if (grandparent.isProgram()) {
    return true;
  }
  if (grandparent.isExportNamedDeclaration()) {
    return grandparent.parentPath?.isProgram() ?? false;
  }
  return false;
}

/**
 * Walk up to the enclosing module-level function, if any: a top-level
 * function declaration (`getUrls`), a top-level variable holding a function
 * (`getUrls`), or a method of a top-level object (`urlsApi.list`,
 * `default.list` for a default-exported object). Nested functions attribute
 * to their outermost module-level function. Components and hooks are checked
 * before this, so they never land here.
 */
function findNearestModuleFunction(path: NodePath<Node>): string | undefined {
  let current: NodePath<Node> | null = path;
  let methodName: string | undefined;
  while (current) {
    const node = current.node;
    if (
      node.type === "ObjectMethod" &&
      node.key.type === "Identifier" &&
      !methodName
    ) {
      methodName = node.key.name;
    }
    if (
      node.type === "ObjectProperty" &&
      node.key.type === "Identifier" &&
      isFunctionNode(node.value) &&
      !methodName
    ) {
      methodName = node.key.name;
    }
    if (
      node.type === "FunctionDeclaration" &&
      node.id &&
      isModuleLevelDeclaration(current)
    ) {
      return node.id.name;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      isModuleLevelDeclarator(current)
    ) {
      return methodName ? `${node.id.name}.${methodName}` : node.id.name;
    }
    if (node.type === "ExportDefaultDeclaration" && methodName) {
      return `default.${methodName}`;
    }
    current = current.parentPath;
  }
  return undefined;
}

/** Walk up to the enclosing custom hook function (`useXxx`), if any. */
function findNearestHook(path: NodePath<Node>): string | undefined {
  let current: NodePath<Node> | null = path;
  while (current) {
    const node = current.node;
    if (
      node.type === "FunctionDeclaration" &&
      node.id &&
      isHookName(node.id.name)
    ) {
      return node.id.name;
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      isHookName(node.id.name)
    ) {
      return node.id.name;
    }
    current = current.parentPath;
  }
  return undefined;
}

function isAxiosCreate(node: CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "axios" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "create"
  );
}

function isLazyCall(node: CallExpression): boolean {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return callee.name === "lazy";
  }
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "React" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "lazy"
  );
}

function getJsxName(
  name: JSXIdentifier | JSXMemberExpression | JSXNamespacedName
): string | undefined {
  if (name.type === "JSXIdentifier") {
    return name.name;
  }

  if (name.type === "JSXMemberExpression") {
    const object = getJsxName(name.object);
    const property = getJsxName(name.property);
    return [object, property].filter(Boolean).join(".");
  }

  return undefined;
}

function extractRoute(attributes: Array<JSXAttribute | JSXSpreadAttribute>): RouteInfo | undefined {
  const route: RouteInfo = { path: "unknown" };

  for (const attribute of attributes) {
    if (attribute.type !== "JSXAttribute") {
      continue;
    }

    const name = getJsxName(attribute.name);
    if (name === "path") {
      route.path = getStringAttributeValue(attribute) ?? "unknown";
    }

    if (name === "element") {
      route.component = getRouteElementName(attribute);
    }
  }

  return route.path !== "unknown" || route.component ? route : undefined;
}

function getStringAttributeValue(attribute: JSXAttribute): string | undefined {
  if (!attribute.value) {
    return undefined;
  }

  if (attribute.value.type === "StringLiteral") {
    return attribute.value.value;
  }

  return undefined;
}

function getRouteElementName(attribute: JSXAttribute): string | undefined {
  const value = attribute.value;
  if (!value || value.type !== "JSXExpressionContainer") {
    return undefined;
  }

  const expression = value.expression;
  if (expression.type === "JSXElement") {
    return getJsxName(expression.openingElement.name);
  }

  if (expression.type === "Identifier") {
    return expression.name;
  }

  return undefined;
}

function getHookName(node: CallExpression): string | undefined {
  if (node.callee.type === "Identifier" && /^use[A-Z0-9]/.test(node.callee.name)) {
    return node.callee.name;
  }

  if (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "React" &&
    node.callee.property.type === "Identifier" &&
    /^use[A-Z0-9]/.test(node.callee.property.name)
  ) {
    return node.callee.property.name;
  }

  return undefined;
}

function getApiCall(
  node: CallExpression,
  axiosInstances: Set<string>,
  importedNames: Set<string>
): ApiCallInfo | undefined {
  if (isFetchCall(node)) {
    return {
      method: getFetchMethod(node.arguments[1]) ?? "GET",
      endpoint: getStringExpression(node.arguments[0]) ?? "dynamic fetch()"
    };
  }

  if (node.callee.type === "MemberExpression") {
    const object = node.callee.object;
    const property = node.callee.property;
    const propertyName =
      property.type === "Identifier"
        ? property.name
        : property.type === "StringLiteral"
          ? property.value
          : undefined;

    if (object.type === "Identifier" && propertyName) {
      // Only real HTTP verbs count: `axios.create()`, `axios.all()`,
      // `axios.isAxiosError()` are not requests.
      const method = propertyName.toLowerCase();
      if (!HTTP_METHODS.has(method)) {
        return undefined;
      }
      if (object.name === "axios" || axiosInstances.has(object.name)) {
        return {
          method: method.toUpperCase(),
          endpoint:
            getStringExpression(node.arguments[0]) ?? `dynamic axios.${method}()`
        };
      }
      // Imported HTTP client: the standard pattern creates the axios instance
      // in one module (`api = axios.create(...)`) and imports it everywhere
      // else, so per-file instance tracking misses those calls. An imported
      // object calling an HTTP verb with a URL-like first argument is an API
      // call. (A local object such as an Express `router` is not imported,
      // so server-route definitions are not counted.)
      if (
        importedNames.has(object.name) &&
        isUrlLikeArgument(node.arguments[0])
      ) {
        return {
          method: method.toUpperCase(),
          endpoint:
            getStringExpression(node.arguments[0]) ??
            `dynamic ${object.name}.${method}()`
        };
      }
    }
  }

  return undefined;
}

/** True when the argument is a URL-like literal: a string or template
 * starting with `/` or `http`. */
function isUrlLikeArgument(
  arg: CallExpression["arguments"][number] | undefined
): boolean {
  if (!arg) {
    return false;
  }
  if (arg.type === "StringLiteral") {
    return arg.value.startsWith("/") || arg.value.startsWith("http");
  }
  if (arg.type === "TemplateLiteral") {
    const first = arg.quasis[0]?.value.cooked ?? "";
    return first.startsWith("/") || first.startsWith("http");
  }
  return false;
}

function isFetchCall(node: CallExpression): boolean {
  if (node.callee.type === "Identifier") {
    return node.callee.name === "fetch";
  }

  return (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    (node.callee.object.name === "window" || node.callee.object.name === "globalThis") &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "fetch"
  );
}

/** Read the HTTP method from a fetch init object: `fetch(url, { method })`. */
function getFetchMethod(
  init: CallExpression["arguments"][number] | undefined
): string | undefined {
  if (!init || init.type !== "ObjectExpression") {
    return undefined;
  }

  for (const property of init.properties) {
    if (property.type !== "ObjectProperty") {
      continue;
    }
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "StringLiteral"
          ? property.key.value
          : undefined;
    if (key === "method" && property.value.type === "StringLiteral") {
      return property.value.value.toUpperCase();
    }
  }

  return undefined;
}

function getStringExpression(node: CallExpression["arguments"][number] | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === "StringLiteral") {
    return node.value;
  }

  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }

  return undefined;
}
