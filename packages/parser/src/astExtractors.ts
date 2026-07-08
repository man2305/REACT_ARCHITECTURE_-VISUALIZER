import { parse } from "@babel/parser";
import traverseModule, { NodePath } from "@babel/traverse";
import type {
  ApiCallInfo,
  ComponentInfo,
  ImportInfo,
  RouteInfo
} from "@rav/shared";
import type {
  CallExpression,
  ExportDefaultDeclaration,
  Expression,
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

type ExtractedFile = {
  components: ComponentInfo[];
  parseError?: string;
};

type MutableComponent = Omit<ComponentInfo, "jsxChildren" | "hooks" | "providers"> & {
  jsxChildren: Set<string>;
  hooks: Set<string>;
  providers: Set<string>;
};

const PARSER_PLUGINS = [
  "jsx",
  "typescript",
  "classProperties",
  "decorators-legacy",
  "dynamicImport",
  "importMeta"
] as const;

const traverse = (
  "default" in traverseModule ? traverseModule.default : traverseModule
) as typeof traverseModule;

export function extractFile(path: string, content: string): ExtractedFile {
  const lineCount = content.split(/\r?\n/).length;
  const imports: ImportInfo[] = [];
  const componentMap = new Map<string, MutableComponent>();

  try {
    const ast = parse(content, {
      sourceType: "module",
      errorRecovery: true,
      plugins: [...PARSER_PLUGINS]
    });

    function ensureComponent(name: string, exported = false): MutableComponent {
      const existing = componentMap.get(name);
      if (existing) {
        existing.exported ||= exported;
        return existing;
      }

      const component: MutableComponent = {
        name,
        filePath: path,
        lineCount,
        imports,
        jsxChildren: new Set<string>(),
        hooks: new Set<string>(),
        routes: [],
        apiCalls: [],
        providers: new Set<string>(),
        propsToChildren: {},
        exported
      };
      componentMap.set(name, component);
      return component;
    }

    traverse(ast, {
      ImportDeclaration(importPath) {
        imports.push({
          source: importPath.node.source.value,
          importedNames: importPath.node.specifiers.map((specifier) => {
            if ("local" in specifier) {
              return specifier.local.name;
            }
            return "unknown";
          })
        });
      },

      FunctionDeclaration(functionPath) {
        const name = functionPath.node.id?.name;
        if (name && isComponentName(name)) {
          ensureComponent(name, isExported(functionPath));
        }
      },

      VariableDeclarator(variablePath) {
        const name = variablePath.node.id.type === "Identifier" ? variablePath.node.id.name : undefined;
        if (name && isComponentName(name) && isFunctionLikeVariable(variablePath.node)) {
          ensureComponent(name, isExported(variablePath));
        }
      },

      ExportDefaultDeclaration(exportPath) {
        const name = getDefaultExportName(exportPath.node);
        if (name && isComponentName(name)) {
          ensureComponent(name, true);
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
        const component = findNearestComponent(callPath, componentMap);
        if (!component) {
          return;
        }

        const hookName = getHookName(callPath.node);
        if (hookName) {
          component.hooks.add(hookName);
        }

        const apiCall = getApiCall(callPath.node);
        if (apiCall) {
          component.apiCalls.push({
            ...apiCall,
            line: callPath.node.loc?.start.line
          });
        }
      }
    });

    return {
      components: [...componentMap.values()].map((component) => ({
        ...component,
        jsxChildren: [...component.jsxChildren].sort(),
        hooks: [...component.hooks].sort(),
        providers: [...component.providers].sort()
      }))
    };
  } catch (error) {
    return {
      components: [],
      parseError: error instanceof Error ? error.message : "Unknown parse error"
    };
  }
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isFunctionLikeVariable(node: VariableDeclarator): boolean {
  return node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression";
}

function isExported(path: NodePath<Node>): boolean {
  return path.parentPath?.isExportNamedDeclaration() ?? false;
}

function getDefaultExportName(node: ExportDefaultDeclaration): string | undefined {
  if (node.declaration.type === "Identifier") {
    return node.declaration.name;
  }

  if (node.declaration.type === "FunctionDeclaration") {
    return node.declaration.id?.name ?? "DefaultComponent";
  }

  return undefined;
}

function findNearestComponent(
  path: NodePath<Node>,
  components: Map<string, MutableComponent>
): MutableComponent | undefined {
  const functionParent = path.getFunctionParent();
  if (!functionParent) {
    return undefined;
  }

  if (functionParent.node.type === "FunctionDeclaration") {
    const name = functionParent.node.id?.name;
    return name ? components.get(name) : undefined;
  }

  const parent = functionParent.parentPath;
  if (parent?.isVariableDeclarator()) {
    const name = parent.node.id.type === "Identifier" ? parent.node.id.name : undefined;
    return name ? components.get(name) : undefined;
  }

  return undefined;
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

function getApiCall(node: CallExpression): ApiCallInfo | undefined {
  if (node.callee.type === "Identifier" && node.callee.name === "fetch") {
    return {
      method: "GET",
      endpoint: getStringExpression(node.arguments[0]) ?? "dynamic fetch()"
    };
  }

  if (
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "axios" &&
    node.callee.property.type === "Identifier"
  ) {
    const method = node.callee.property.name.toUpperCase();
    return {
      method,
      endpoint: getStringExpression(node.arguments[0]) ?? `dynamic axios.${method.toLowerCase()}()`
    };
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
