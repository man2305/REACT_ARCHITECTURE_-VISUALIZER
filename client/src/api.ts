import type { AnalyzeResponse, SourceFile } from "@rav/shared";

export async function analyzeFiles(files: SourceFile[]): Promise<AnalyzeResponse> {
  const response = await fetch("/api/analyze/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ files })
  });

  await assertOk(response, "Failed to analyze files");

  return response.json() as Promise<AnalyzeResponse>;
}

export async function analyzeGitHubRepository(repositoryUrl: string): Promise<AnalyzeResponse> {
  const response = await fetch("/api/analyze/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ repositoryUrl })
  });

  await assertOk(response, "Failed to analyze GitHub repository");

  return response.json() as Promise<AnalyzeResponse>;
}

async function assertOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json()) as { error?: string };
    throw new Error(body.error ?? fallbackMessage);
  }

  const message = await response.text();
  throw new Error(message || fallbackMessage);
}
