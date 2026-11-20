import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import type { AnalyzeFilesRequest, AnalyzeGithubRequest, AnalyzeResponse } from "@rav/shared";
import { analyzeProject } from "@rav/parser";
import {
  AuditServiceError,
  createOpenAiProvider,
  isValidAuditResponse,
  parseAuditMarkdown
} from "@rav/audit";
import type { ProjectAuditMetadata } from "@rav/audit";
import { fetchGitHubSourceFiles, GitHubSourceError } from "./githubSource.js";
import { trimAuditMetadata } from "./promptCap.js";

const DEFAULT_PORT = 4000;
const MAX_ANALYZE_FILES = 200;
const MAX_FILE_BYTES = 500_000;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const ANALYZE_RATE_LIMIT = 30; // requests per minute per IP
const AUDIT_RATE_LIMIT = 5; // requests per minute per IP (each triggers a paid OpenAI call)
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";
const AUDIT_TIMEOUT_MS = 60_000;

const app = express();

function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`Invalid PORT "${raw}" — falling back to ${DEFAULT_PORT}.`);
    return DEFAULT_PORT;
  }
  return parsed;
}

const port = resolvePort();

// Behind Render's proxy, req.ip comes from X-Forwarded-For. Without this,
// per-IP rate limiting would see the proxy's IP for every client.
app.set("trust proxy", 1);

// Lock CORS to the deployed client origin(s) when configured; allow all
// origins only as a development default when CLIENT_ORIGIN is unset.
const clientOrigins = (process.env.CLIENT_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(clientOrigins.length > 0 ? cors({ origin: clientOrigins }) : cors());
app.use(express.json({ limit: "25mb" }));

const analyzeLimiter = rateLimit({
  windowMs: 60_000,
  limit: ANALYZE_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many analysis requests. Please try again in a minute." }
});

const auditLimiter = rateLimit({
  windowMs: 60_000,
  limit: AUDIT_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many audit requests. Please try again in a minute." }
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "react-architecture-visualizer" });
});

app.post("/api/analyze/files", analyzeLimiter, (request, response) => {
  const body = request.body as Partial<AnalyzeFilesRequest>;

  if (!Array.isArray(body.files)) {
    response.status(400).json({ error: "Expected body.files to be an array of source files." });
    return;
  }

  if (body.files.length > MAX_ANALYZE_FILES) {
    response.status(400).json({
      error: `Too many files: received ${body.files.length}, maximum is ${MAX_ANALYZE_FILES}.`
    });
    return;
  }

  const files: { path: string; content: string }[] = [];
  let filesSkipped = 0;
  let totalBytes = 0;

  for (const entry of body.files) {
    // Invalid entries (null, non-object, wrong shapes) are skipped and
    // counted rather than crashing the request.
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      typeof (entry as { content?: unknown }).content !== "string"
    ) {
      filesSkipped += 1;
      continue;
    }
    const file = entry as { path: string; content: string };
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      response.status(400).json({
        error: `File "${file.path}" exceeds the 500 KB per-file limit.`
      });
      return;
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      response.status(400).json({ error: "Total content exceeds the 15 MB limit." });
      return;
    }
    files.push({ path: file.path, content: file.content });
  }

  let graph;
  try {
    graph = analyzeProject(files);
  } catch (error) {
    console.error("analyzeProject failed:", error);
    response.status(500).json({ error: "Failed to analyze the provided files." });
    return;
  }

  const payload: AnalyzeResponse = {
    graph,
    truncated: filesSkipped > 0,
    totalFiles: body.files.length,
    filesSkipped
  };
  response.json(payload);
});

app.post("/api/analyze/github", analyzeLimiter, async (request, response) => {
  const body = request.body as Partial<AnalyzeGithubRequest>;

  if (typeof body.repositoryUrl !== "string" || body.repositoryUrl.trim().length === 0) {
    response.status(400).json({ error: "Expected repositoryUrl to be a GitHub repository URL." });
    return;
  }

  try {
    const result = await fetchGitHubSourceFiles(body.repositoryUrl, body.ref);

    let graph;
    try {
      graph = analyzeProject(result.files);
    } catch (error) {
      console.error("analyzeProject failed:", error);
      response.status(500).json({ error: "Failed to analyze the repository." });
      return;
    }

    const payload: AnalyzeResponse = {
      graph,
      truncated: result.filesSkipped > 0,
      totalFiles: result.totalFiles,
      filesSkipped: result.filesSkipped
    };
    response.json(payload);
  } catch (error) {
    if (error instanceof GitHubSourceError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    console.error("GitHub analysis failed:", error);
    response.status(500).json({ error: "Failed to load GitHub repository." });
  }
});

app.post("/api/audit", auditLimiter, async (request, response) => {
  const body = request.body as { metadata?: unknown };
  const metadata = body.metadata as ProjectAuditMetadata | undefined;

  if (!isValidAuditMetadata(metadata)) {
    response.status(400).json({ error: "Expected body.metadata to be project audit metadata." });
    return;
  }

  // The key lives only in server env — it is never read from the request.
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    response.status(503).json({
      error: "AI audit is not configured on this server (no OPENAI_API_KEY).",
      code: "audit_unavailable"
    });
    return;
  }

  const provider = createOpenAiProvider({
    apiKey,
    apiUrl: process.env.OPENAI_API_URL?.trim() || OPENAI_API_URL,
    model: process.env.OPENAI_MODEL?.trim() || OPENAI_MODEL,
    timeoutMs: AUDIT_TIMEOUT_MS,
    maxTokens: 4000
  });

  try {
    // Trim the metadata so the prompt stays within the character budget.
    const markdown = await provider.generateAudit(trimAuditMetadata(metadata));
    if (!isValidAuditResponse(markdown)) {
      response.status(502).json({ error: "AI returned an invalid audit response." });
      return;
    }
    response.json({ report: parseAuditMarkdown(markdown, metadata.projectName, provider.name) });
  } catch (error) {
    if (error instanceof AuditServiceError) {
      if (error.kind === "configuration") {
        response.status(503).json({ error: error.message, code: "audit_unavailable" });
        return;
      }
      response.status(502).json({ error: error.message });
      return;
    }
    console.error("AI audit failed:", error);
    response.status(500).json({ error: "AI audit failed." });
  }
});

function isValidAuditMetadata(metadata: unknown): metadata is ProjectAuditMetadata {
  if (metadata === null || typeof metadata !== "object") {
    return false;
  }
  const candidate = metadata as Partial<ProjectAuditMetadata>;
  return (
    typeof candidate.projectName === "string" &&
    candidate.projectName.length > 0 &&
    candidate.dependencyGraph !== undefined &&
    typeof candidate.dependencyGraph === "object" &&
    Array.isArray(candidate.dependencyGraph.nodes) &&
    Array.isArray(candidate.dependencyGraph.edges)
  );
}

// Guarantee JSON error bodies — Express's default handler returns HTML,
// which the client would surface as raw text.
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError) {
    response.status(400).json({ error: "Request body is not valid JSON." });
    return;
  }
  console.error("Unhandled error:", error);
  response.status(500).json({ error: "Internal server error." });
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
