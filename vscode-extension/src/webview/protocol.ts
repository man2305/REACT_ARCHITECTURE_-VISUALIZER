import type { ArchitectureGraph } from "@rav/shared";
import type { ArchitectureAuditReport, AuditError } from "@rav/audit";

export type ExtensionToWebviewMessage =
  | {
      type: "graph";
      payload: {
        name: string;
        graph: ArchitectureGraph;
        analyzedFileCount: number;
        totalFileCount: number;
        truncated: boolean;
        folderCount: number;
      };
    }
  | { type: "status"; payload: { isAnalyzing: boolean; error?: string } }
  | { type: "settings"; payload: { watchEnabled: boolean } }
  | {
      type: "audit-result";
      payload: ({ report: ArchitectureAuditReport } | { error: AuditError }) & {
        requestId?: string;
      };
    };

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "audit-request"; payload: { requestId: string } }
  | { type: "set-watch"; payload: { enabled: boolean } }
  | { type: "open-file"; payload: { path: string } };
