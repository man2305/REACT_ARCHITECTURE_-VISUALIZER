import cors from "cors";
import express from "express";
import type { AnalyzeFilesRequest, AnalyzeGithubRequest, AnalyzeResponse } from "@rav/shared";
import { analyzeProject } from "@rav/parser";
import { fetchGitHubSourceFiles } from "./githubSource.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "react-architecture-visualizer" });
});

app.post("/api/analyze/files", (request, response) => {
  const body = request.body as Partial<AnalyzeFilesRequest>;

  if (!Array.isArray(body.files)) {
    response.status(400).json({ error: "Expected body.files to be an array of source files." });
    return;
  }

  const graph = analyzeProject(
    body.files
      .filter((file) => typeof file.path === "string" && typeof file.content === "string")
      .map((file) => ({ path: file.path, content: file.content }))
  );

  const payload: AnalyzeResponse = { graph };
  response.json(payload);
});

app.post("/api/analyze/github", async (request, response) => {
  const body = request.body as Partial<AnalyzeGithubRequest>;

  if (typeof body.repositoryUrl !== "string" || body.repositoryUrl.trim().length === 0) {
    response.status(400).json({ error: "Expected repositoryUrl to be a GitHub repository URL." });
    return;
  }

  try {
    const files = await fetchGitHubSourceFiles(body.repositoryUrl, body.ref);
    const payload: AnalyzeResponse = { graph: analyzeProject(files) };
    response.json(payload);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Failed to load GitHub repository."
    });
  }
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
