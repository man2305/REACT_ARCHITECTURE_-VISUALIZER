import type { ArchitectureAuditReport } from "@rav/audit";

const CACHE_PREFIX = "rav-ai-audit:";

function cacheKey(projectName: string, graphGeneratedAt: string): string {
  return `${CACHE_PREFIX}${projectName}::${graphGeneratedAt}`;
}

export function getCachedAudit(
  projectName: string,
  graphGeneratedAt: string
): ArchitectureAuditReport | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(projectName, graphGeneratedAt));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ArchitectureAuditReport;
  } catch {
    return null;
  }
}

export function setCachedAudit(
  projectName: string,
  graphGeneratedAt: string,
  report: ArchitectureAuditReport
): void {
  try {
    sessionStorage.setItem(cacheKey(projectName, graphGeneratedAt), JSON.stringify(report));
  } catch {
    // Session storage may be full or unavailable — silently ignore.
  }
}

export function clearAuditCache(): void {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // Ignore storage errors.
  }
}
