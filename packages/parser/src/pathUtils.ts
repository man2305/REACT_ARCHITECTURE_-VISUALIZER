export type ImportAliases = Record<string, string>;

/** Default path aliases: `@/` maps to the conventional `src/` directory. */
export const DEFAULT_ALIASES: ImportAliases = {
  "@": "src"
};

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}

export function isSourceFile(path: string): boolean {
  return /\.(tsx|ts|jsx|js)$/i.test(path) && !path.includes("node_modules/");
}

export function withoutExtension(path: string): string {
  return path.replace(/\.(tsx|ts|jsx|js)$/i, "");
}

export function buildPathIndex(paths: string[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    const noExt = withoutExtension(path);
    index.set(noExt, path);

    if (noExt.endsWith("/index")) {
      index.set(noExt.slice(0, -"/index".length), path);
    }
  }

  return index;
}

/**
 * Resolve an import source to a file in the project.
 *
 * Handles relative imports (`./x`, `../x`) and path aliases (`@/x`,
 * configurable via `aliases`). Bare package imports (`react`, `axios`)
 * return `undefined` — they are external dependencies.
 */
export function resolveImport(
  fromPath: string,
  source: string,
  pathIndex: Map<string, string>,
  aliases: ImportAliases = DEFAULT_ALIASES
): string | undefined {
  if (source.startsWith(".")) {
    return resolveRelativeImport(fromPath, source, pathIndex);
  }

  for (const [prefix, target] of Object.entries(aliases)) {
    const cleanPrefix = prefix.replace(/\/$/, "");
    const cleanTarget = target.replace(/^\.\//, "").replace(/\/$/, "");
    if (!cleanPrefix) {
      continue;
    }

    if (source === cleanPrefix) {
      const resolved = lookupPath(cleanTarget, pathIndex);
      if (resolved) {
        return resolved;
      }
      continue;
    }

    if (source.startsWith(`${cleanPrefix}/`)) {
      const rest = source.slice(cleanPrefix.length + 1);
      const joined = cleanTarget ? `${cleanTarget}/${rest}` : rest;
      const resolved = lookupPath(joined, pathIndex);
      if (resolved) {
        return resolved;
      }
    }
  }

  return undefined;
}

function lookupPath(target: string, pathIndex: Map<string, string>): string | undefined {
  return pathIndex.get(withoutExtension(target));
}

export function resolveRelativeImport(
  fromPath: string,
  source: string,
  pathIndex: Map<string, string>
): string | undefined {
  if (!source.startsWith(".")) {
    return undefined;
  }

  const fromParts = normalizePath(fromPath).split("/");
  fromParts.pop();
  const targetParts = [...fromParts, ...source.split("/")];
  const normalizedParts: string[] = [];

  for (const part of targetParts) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      normalizedParts.pop();
      continue;
    }

    normalizedParts.push(part);
  }

  const target = normalizedParts.join("/");

  // The index is keyed by extension-less paths, so strip the extension once
  // before lookup. This also resolves explicit extensions (`./utils.js` means
  // `utils.ts` under TS `nodenext`/`bundler` resolution).
  return lookupPath(target, pathIndex);
}
