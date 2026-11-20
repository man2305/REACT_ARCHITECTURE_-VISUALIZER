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
      const resolved =
        lookupPath(cleanTarget, pathIndex) ??
        lookupPathSuffix(fromPath, cleanTarget, pathIndex);
      if (resolved) {
        return resolved;
      }
      continue;
    }

    if (source.startsWith(`${cleanPrefix}/`)) {
      const rest = source.slice(cleanPrefix.length + 1);
      const joined = cleanTarget ? `${cleanTarget}/${rest}` : rest;
      const resolved =
        lookupPath(joined, pathIndex) ??
        lookupPathSuffix(fromPath, joined, pathIndex);
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

/**
 * Fall back for aliases when the target root is nested: a repo whose sources
 * live under `frontend/src/` (or `client/src/`, `packages/app/src/`, ...) has
 * no top-level `src/`, so `@/components/Button` cannot resolve to
 * `src/components/Button`. Match the target as a path suffix instead
 * (`frontend/src/components/Button`). Ambiguous matches stay unresolved,
 * except when exactly one match sits under the importing file's own top-level
 * directory (the usual monorepo case: a file in `frontend/` means
 * `frontend/src/`).
 */
function lookupPathSuffix(
  fromPath: string,
  target: string,
  pathIndex: Map<string, string>
): string | undefined {
  const suffix = `/${withoutExtension(target)}`;
  const matches = new Set<string>();
  for (const [key, value] of pathIndex) {
    if (key.endsWith(suffix)) {
      matches.add(value);
    }
  }

  if (matches.size === 0) {
    return undefined;
  }
  if (matches.size === 1) {
    return [...matches][0];
  }

  const topDir = normalizePath(fromPath).split("/")[0];
  const local = [...matches].filter((match) =>
    normalizePath(match).startsWith(`${topDir}/`)
  );
  return local.length === 1 ? local[0] : undefined;
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
