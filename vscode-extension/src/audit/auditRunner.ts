import * as vscode from "vscode";
import type { ArchitectureGraph } from "@rav/shared";
import {
  AuditServiceError,
  createMetadataProvider,
  createOpenAiProvider,
  generateProjectMetadata,
  isMetadataEmpty,
  isValidAuditResponse,
  parseAuditMarkdown
} from "@rav/audit";
import type { ArchitectureAuditReport, AuditError } from "@rav/audit";

/** SecretStorage key for the OpenAI API key (see E-M8: never store it in settings). */
export const OPENAI_API_KEY_SECRET = "reactArchitectureVisualizer.openai.apiKey";

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

export async function runAudit(
  projectName: string,
  graph: ArchitectureGraph,
  secrets: vscode.SecretStorage
): Promise<AuditResult> {
  try {
    // Metadata generation runs inside the try: a throw here used to reject
    // before the try block, leaving the webview's audit spinner running forever.
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
    const apiKey = (await secrets.get(OPENAI_API_KEY_SECRET))?.trim() ?? "";

    const provider = apiKey
      ? createOpenAiProvider({
          apiKey,
          apiUrl: config.get<string>("openai.apiUrl") ?? "https://api.openai.com/v1/chat/completions",
          model: config.get<string>("openai.model") ?? "gpt-4o-mini"
        })
      : createMetadataProvider();

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
