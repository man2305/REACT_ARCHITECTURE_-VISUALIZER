import type { AnalyzeResponse, SourceFile } from "@rav/shared";

export async function analyzeFiles(files: SourceFile[]): Promise<AnalyzeResponse> {
  const response = await fetch("/api/analyze/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ files })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to analyze files");
  }

  return response.json() as Promise<AnalyzeResponse>;
}
