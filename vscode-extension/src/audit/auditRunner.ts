import * as vscode from "vscode";
import type { ArchitectureGraph } from "@rav/shared";
import {
  generateProjectMetadata,
  isMetadataEmpty
} from "../../../client/src/audit/projectMetadata";
import {
  isValidAuditResponse,
  parseAuditMarkdown
} from "../../../client/src/audit/parseAuditReport";
import type { ArchitectureAuditReport, AuditError } from "../../../client/src/audit/types";
import {
  AuditServiceError,
  createMetadataProvider,
  createOpenAiProvider
} from "./aiAuditService";

export type AuditResult =
  | { report: ArchitectureAuditReport; error?: never }
  | { report?: never; error: AuditError };

function toAuditError(error: unknown): AuditError {
  if (error instanceof AuditServiceError) {
    const kindMap: Record<AuditServiceError["kind"], AuditError["kind"]> = {
      network: "network",
      timeout: "timeout",
      "invalid-response": "invalid-response",
      configuration: "network"
    };
    return { kind: kindMap[error.kind], message: error.message };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "An unexpected error occurred."
  };
}

export async function runAudit(projectName: string, graph: ArchitectureGraph): Promise<AuditResult> {
  const metadata = generateProjectMetadata(projectName, graph);

  if (isMetadataEmpty(metadata)) {
    return {
      error: {
        kind: "empty-metadata",
        message: "No analyzable project metadata found. Load a repository with React components first."
      }
    };
  }

  const config = vscode.workspace.getConfiguration("reactArchitectureVisualizer");
  const apiKey = config.get<string>("openai.apiKey")?.trim() ?? "";

  const provider = apiKey
    ? createOpenAiProvider({
        apiKey,
        apiUrl: config.get<string>("openai.apiUrl") ?? "https://api.openai.com/v1/chat/completions",
        model: config.get<string>("openai.model") ?? "gpt-4o-mini"
      })
    : createMetadataProvider();

  try {
    const markdown = await provider.generateAudit(metadata);

    if (!isValidAuditResponse(markdown)) {
      return {
        error: {
          kind: "invalid-response",
          message: "The AI returned an incomplete audit report. Please try again."
        }
      };
    }

    return { report: parseAuditMarkdown(markdown, projectName, provider.name) };
  } catch (error) {
    return { error: toAuditError(error) };
  }
}
