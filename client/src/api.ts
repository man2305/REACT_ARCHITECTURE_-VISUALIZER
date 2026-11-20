import type { AnalyzeResponse, SourceFile } from "@rav/shared";
import { AuditServiceError } from "@rav/audit";
import type { ArchitectureAuditReport, ProjectAuditMetadata } from "@rav/audit";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "";

/** Aborts analysis/audit requests that run longer than this. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Thrown by auditGraph when the server has no OpenAI key configured
 * (HTTP 503 with code "audit_unavailable"). The caller falls back to the
 * local rule-based summary instead of showing an error.
 */
export class AuditUnavailableError extends Error {
  constructor() {
    super("AI audit is not configured on the server.");
    this.name = "AuditUnavailableError";
  }
}

/** True when the error is a user-initiated abort (Cancel button), not a failure. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

type FetchOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * fetch with a timeout and an optional external abort signal.
 * A timeout rejects with a plain Error mentioning "timed out"; a user
 * cancel rejects with a DOMException named "AbortError" (see isAbortError).
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  { timeoutMs = REQUEST_TIMEOUT_MS, signal }: FetchOptions = {}
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`Request timed out after ${timeoutMs / 1000} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    },
    { signal }
  );
}

export async function analyzeFiles(files: SourceFile[], signal?: AbortSignal): Promise<AnalyzeResponse> {
  const response = await postJson(`${API_BASE_URL}/api/analyze/files`, { files }, signal);

  await assertOk(response, "Failed to analyze files");

  return response.json() as Promise<AnalyzeResponse>;
}

export async function analyzeGitHubRepository(
  repositoryUrl: string,
  ref?: string,
  signal?: AbortSignal
): Promise<AnalyzeResponse> {
  const response = await postJson(
    `${API_BASE_URL}/api/analyze/github`,
    ref ? { repositoryUrl, ref } : { repositoryUrl },
    signal
  );

  await assertOk(response, "Failed to analyze GitHub repository");

  return response.json() as Promise<AnalyzeResponse>;
}

/**
 * Requests an AI architecture audit from the server (POST /api/audit).
 * The OpenAI key lives on the server only — the client never sees it.
 * Throws AuditUnavailableError when the server has no key configured;
 * throws AuditServiceError for timeouts, network failures, and bad responses.
 */
export async function auditGraph(
  metadata: ProjectAuditMetadata,
  signal?: AbortSignal
): Promise<{ report: ArchitectureAuditReport }> {
  let response: Response;
  try {
    response = await postJson(`${API_BASE_URL}/api/audit`, { metadata }, signal);
  } catch (error) {
    if (error instanceof Error && error.message.includes("timed out")) {
      throw new AuditServiceError(
        "The audit request timed out after 120 seconds. Please try again.",
        "timeout"
      );
    }
    if (isAbortError(error)) {
      throw error;
    }
    throw new AuditServiceError(
      "Could not reach the API server. Check that it is running and try again.",
      "network"
    );
  }

  if (response.status === 503) {
    const body = await safeParseJson(response);
    if (body?.code === "audit_unavailable") {
      throw new AuditUnavailableError();
    }
  }

  await assertOk(response, "Failed to generate AI audit");

  const body = (await response.json()) as { report?: ArchitectureAuditReport };
  if (!body?.report || !Array.isArray(body.report.sections)) {
    throw new AuditServiceError(
      "The server returned an incomplete audit report.",
      "invalid-response"
    );
  }

  return { report: body.report };
}

async function safeParseJson(response: Response): Promise<{ code?: string; error?: string } | null> {
  try {
    return (await response.json()) as { code?: string; error?: string };
  } catch {
    return null;
  }
}

async function assertOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    // Malformed JSON yields null here instead of a raw SyntaxError.
    const body = await safeParseJson(response);
    throw new Error(body?.error ?? fallbackMessage);
  }

  let message = "";
  try {
    message = await response.text();
  } catch {
    // Body unreadable — use the fallback message.
  }
  throw new Error(message || fallbackMessage);
}
