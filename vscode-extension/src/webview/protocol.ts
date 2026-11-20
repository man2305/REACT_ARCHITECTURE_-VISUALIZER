import type { ArchitectureGraph } from "@rav/shared";
import type { ArchitectureAuditReport, AuditError } from "@rav/audit";

export type ExtensionToWebviewMessage =
  | { type: "graph"; payload: { name: string; graph: ArchitectureGraph; analyzedFileCount: number } }
  | { type: "status"; payload: { isAnalyzing: boolean; error?: string } }
  | { type: "audit-result"; payload: { report: ArchitectureAuditReport } | { error: AuditError } };

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "audit-request" }
  | { type: "set-watch"; payload: { enabled: boolean } }
  | { type: "open-file"; payload: { path: string } };
