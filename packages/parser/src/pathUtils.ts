const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

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

  if (pathIndex.has(target)) {
    return pathIndex.get(target);
  }

  for (const extension of EXTENSIONS) {
    const withExtension = `${target}${extension}`;
    if (pathIndex.has(withoutExtension(withExtension))) {
      return pathIndex.get(withoutExtension(withExtension));
    }
  }

  return undefined;
}
