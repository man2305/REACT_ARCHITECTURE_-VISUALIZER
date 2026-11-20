import {
  AuditServiceError,
  createMetadataProvider,
  isValidAuditResponse,
  parseAuditMarkdown
} from "@rav/audit";
import type { ArchitectureAuditReport, ProjectAuditMetadata } from "@rav/audit";
import { auditGraph, AuditUnavailableError } from "../api";

export type AuditGenerationMode = "ai" | "fallback";

export type AuditGenerationResult = {
  report: ArchitectureAuditReport;
  mode: AuditGenerationMode;
};

/**
 * Generates an architecture audit for the given project metadata.
 *
 * The AI audit runs on the server (POST /api/audit) — the OpenAI key never
 * reaches the browser. When the server has no key configured it answers
 * 503 "audit_unavailable" and this falls back to the local rule-based
 * summary (createMetadataProvider), which only restates static-analysis
 * numbers. The caller must label fallback reports honestly in the UI;
 * `mode` (and `report.provider`) tells it which path produced the report.
 *
 * `onFallback` fires the moment the fallback path starts, so the UI can
 * switch its loading copy before the summary is generated.
 */
export async function generateArchitectureAudit(
  metadata: ProjectAuditMetadata,
  onFallback?: () => void,
  signal?: AbortSignal
): Promise<AuditGenerationResult> {
  try {
    const { report } = await auditGraph(metadata, signal);
    return { report, mode: "ai" };
  } catch (error) {
    if (!(error instanceof AuditUnavailableError)) {
      throw error;
    }
  }

  onFallback?.();

  const provider = createMetadataProvider();
  const markdown = await provider.generateAudit(metadata);

  if (!isValidAuditResponse(markdown)) {
    throw new AuditServiceError(
      "The local summary generator returned an incomplete report. Please try again.",
      "invalid-response"
    );
  }

  return {
    report: parseAuditMarkdown(markdown, metadata.projectName, provider.name),
    mode: "fallback"
  };
}
