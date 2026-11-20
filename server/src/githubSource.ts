import type { SourceFile } from "@rav/shared";
import { createGunzip } from "node:zlib";

const SOURCE_FILE_PATTERN = /\.(tsx|ts|jsx|js)$/i;
const TEST_FILE_PATTERN = /\.(test|spec|stories)\.[tj]sx?$/i;
/** Build-output folders, ignored only at the repo root (so src/dist/ is kept). */
const IGNORED_ROOT_DIRS = new Set([
  "dist",
  "build",
  "coverage",
  ".next",
  "public",
  "storybook-static"
]);
/** Never source, at any depth. */
const IGNORED_ANY_DEPTH = new Set(["node_modules", ".git"]);
const MAX_FILES = 120;
const MAX_FILE_BYTES = 500_000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024; // 50 MB compressed
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB decompressed
const GITHUB_API_TIMEOUT_MS = 30_000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;

export type GitHubSourceResult = {
  files: SourceFile[];
  /** Source files that passed the ignore/test filters, before caps. */
  totalFiles: number;
  /** Candidates dropped by the file-count cap, per-file size cap, or malformed entries. */
  filesSkipped: number;
};

type GitHubRepository = {
  default_branch: string;
  full_name: string;
};

type GitHubBranch = {
  name: string;
};

type ParsedGitHubUrl = {
  owner: string;
  repo: string;
  /** Path segments after /tree/<ref> — the ref itself may contain slashes. */
  treePath?: string[];
};

/** Error carrying the HTTP status the route should respond with. */
export class GitHubSourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502 | 504
  ) {
    super(message);
    this.name = "GitHubSourceError";
  }
}

export async function fetchGitHubSourceFiles(
  repositoryUrl: string,
  requestedRef?: string
): Promise<GitHubSourceResult> {
  const parsed = parseGitHubUrl(repositoryUrl);
  const repository = await requestGitHubJson<GitHubRepository>(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`
  );
  const ref =
    requestedRef?.trim() ||
    (await resolveTreeRef(parsed.owner, parsed.repo, parsed.treePath)) ||
    repository.default_branch;
  const result = await downloadRepositorySourceFiles(parsed.owner, parsed.repo, ref);

  if (result.files.length === 0) {
    throw new GitHubSourceError("No React source files were found in that repository.", 400);
  }

  return result;
}

/** Exported for testing. */
export function parseGitHubUrl(repositoryUrl: string): ParsedGitHubUrl {
  let url: URL;

  try {
    url = new URL(repositoryUrl.trim());
  } catch {
    throw new GitHubSourceError("Enter a valid GitHub repository URL.", 400);
  }

  const hostname = url.hostname.replace(/^www\./, "");
  if (hostname !== "github.com") {
    throw new GitHubSourceError("Only public github.com repository URLs are supported right now.", 400);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repoWithGit, view, ...rest] = parts;
  const repo = repoWithGit?.replace(/\.git$/i, "");

  if (!owner || !repo) {
    throw new GitHubSourceError("GitHub URL should look like https://github.com/owner/repo.", 400);
  }

  return {
    owner,
    repo,
    treePath: view === "tree" && rest.length > 0 ? rest : undefined
  };
}

/**
 * Resolve the branch from a /tree/<ref>/... URL. Branch names may contain
 * slashes, so match the longest prefix of the tree path against the repo's
 * branch list. Falls back to the full path joined with "/" when the branch
 * list cannot be fetched (e.g. rate-limited).
 */
async function resolveTreeRef(
  owner: string,
  repo: string,
  treePath?: string[]
): Promise<string | undefined> {
  if (!treePath || treePath.length === 0) {
    return undefined;
  }

  try {
    const branches = await requestGitHubJson<GitHubBranch[]>(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`
    );
    const names = new Set(branches.map((branch) => branch.name));
    for (let length = treePath.length; length >= 1; length -= 1) {
      const candidate = treePath.slice(0, length).join("/");
      if (names.has(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Fall through to the joined-path guess below.
  }

  return treePath.join("/");
}

function gitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "react-architecture-visualizer"
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function requestGitHubJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: gitHubHeaders(),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS)
    });
  } catch (error) {
    throw toGitHubSourceError(error, "GitHub request failed.");
  }

  if (!response.ok) {
    const described = await describeGitHubError(response);
    throw new GitHubSourceError(described.message, described.status);
  }

  return response.json() as Promise<T>;
}

async function downloadRepositorySourceFiles(
  owner: string,
  repo: string,
  ref: string
): Promise<GitHubSourceResult> {
  const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  let response: Response;
  try {
    response = await fetch(archiveUrl, {
      headers: gitHubHeaders(),
      signal: AbortSignal.timeout(ARCHIVE_DOWNLOAD_TIMEOUT_MS)
    });
  } catch (error) {
    throw toGitHubSourceError(error, "Failed to download repository archive from GitHub.");
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new GitHubSourceError(
        "GitHub repository or branch was not found. Make sure it is public.",
        400
      );
    }
    throw new GitHubSourceError("Failed to download repository archive from GitHub.", 502);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_ARCHIVE_BYTES) {
    throw new GitHubSourceError(
      `Repository archive is too large (${formatBytes(Number(contentLength))} — the limit is ${formatBytes(MAX_ARCHIVE_BYTES)}).`,
      502
    );
  }

  const compressed = await readBoundedBody(response, MAX_ARCHIVE_BYTES);
  const tarBuffer = await gunzipBounded(compressed, MAX_DECOMPRESSED_BYTES);
  return extractSourceFilesFromTar(tarBuffer);
}

/** Stream the response body, aborting as soon as the byte cap is exceeded. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    throw new GitHubSourceError("GitHub returned an empty response.", 502);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) {
        await response.body.cancel().catch(() => undefined);
        throw new GitHubSourceError(
          `Repository archive exceeds the ${formatBytes(maxBytes)} limit.`,
          502
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    throw toGitHubSourceError(error, "Failed to download repository archive from GitHub.");
  }
  return Buffer.concat(chunks);
}

/** Gunzip through a stream, aborting as soon as the decompressed cap is exceeded. */
function gunzipBounded(compressed: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      gunzip.destroy();
      reject(error);
    };

    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(
          new GitHubSourceError(
            `Decompressed repository archive exceeds the ${formatBytes(maxBytes)} limit.`,
            502
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    gunzip.on("error", (error) => {
      fail(new GitHubSourceError(`Failed to decompress repository archive: ${error.message}`, 502));
    });
    gunzip.end(compressed);
  });
}

function toGitHubSourceError(error: unknown, fallback: string): GitHubSourceError {
  if (error instanceof GitHubSourceError) {
    return error;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new GitHubSourceError("GitHub request timed out.", 504);
  }
  return new GitHubSourceError(
    error instanceof Error ? `${fallback} ${error.message}` : fallback,
    502
  );
}

async function describeGitHubError(
  response: Response
): Promise<{ message: string; status: 400 | 502 }> {
  if (response.status === 404) {
    return {
      message: "GitHub repository or branch was not found. Make sure it is public.",
      status: 400
    };
  }

  if (response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (remaining === "0") {
      const retry = reset ? formatResetTime(reset) : "later";
      return { message: `GitHub rate limit reached. Try again ${retry}.`, status: 502 };
    }
    return {
      message: "GitHub refused the request (403). The repository may be temporarily unavailable.",
      status: 502
    };
  }

  try {
    const body = (await response.json()) as { message?: string };
    return {
      message: body.message ?? `GitHub request failed with status ${response.status}.`,
      status: 502
    };
  } catch {
    return { message: `GitHub request failed with status ${response.status}.`, status: 502 };
  }
}

function formatResetTime(resetSeconds: string): string {
  const resetAt = Number(resetSeconds) * 1000;
  if (!Number.isFinite(resetAt)) {
    return "later";
  }
  const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
  if (minutes < 120) {
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `at ${new Date(resetAt).toUTCString()}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/** Exported for testing. */
export function extractSourceFilesFromTar(tarBuffer: Buffer): GitHubSourceResult {
  const files: SourceFile[] = [];
  let totalFiles = 0;
  let filesSkipped = 0;
  let offset = 0;
  let pendingLongName: string | undefined;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const rawName = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const type = readTarString(header, 156, 1);

    // Malformed size field: count the entry as skipped and resync to the next
    // plausible ustar header instead of ending extraction silently.
    if (!Number.isFinite(size) || size < 0) {
      filesSkipped += 1;
      const next = findNextHeader(tarBuffer, offset + 512);
      if (next === -1) {
        break;
      }
      offset = next;
      pendingLongName = undefined;
      continue;
    }

    const dataStart = offset + 512;
    const dataEnd = Math.min(dataStart + size, tarBuffer.length);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") {
      // GNU longname: the data is the full path of the NEXT entry.
      pendingLongName = tarBuffer
        .subarray(dataStart, dataEnd)
        .toString("utf8")
        .replace(/\0.*$/, "");
      continue;
    }

    if (type === "x") {
      // POSIX pax extended header: a path= record overrides the next entry's name.
      const paxPath = parsePaxPath(tarBuffer.subarray(dataStart, dataEnd).toString("utf8"));
      if (paxPath) {
        pendingLongName = paxPath;
      }
      continue;
    }

    // Only regular files carry source; directories, symlinks and hardlinks are skipped.
    if (type !== "0" && type !== "") {
      pendingLongName = undefined;
      continue;
    }

    const name = pendingLongName ?? [prefix, rawName].filter(Boolean).join("/");
    pendingLongName = undefined;
    const path = stripArchiveRoot(name);

    if (!SOURCE_FILE_PATTERN.test(path) || isIgnoredPath(path) || TEST_FILE_PATTERN.test(path)) {
      continue;
    }

    totalFiles += 1;

    if (files.length >= MAX_FILES || size > MAX_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }

    files.push({ path, content: tarBuffer.subarray(dataStart, dataEnd).toString("utf8") });
  }

  return { files, totalFiles, filesSkipped };
}

function isIgnoredPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return true;
  }
  if (IGNORED_ROOT_DIRS.has(segments[0])) {
    return true;
  }
  return segments.some((segment) => IGNORED_ANY_DEPTH.has(segment));
}

/** Scan forward in 512-byte steps for the next header with ustar magic. */
function findNextHeader(buffer: Buffer, from: number): number {
  for (let offset = from; offset + 512 <= buffer.length; offset += 512) {
    if (buffer.subarray(offset + 257, offset + 262).toString("ascii") === "ustar") {
      return offset;
    }
  }
  return -1;
}

/** Parse pax extended-header records (`<len> <key>=<value>\n`) for a path= override. */
function parsePaxPath(data: string): string | undefined {
  let index = 0;
  while (index < data.length) {
    const space = data.indexOf(" ", index);
    if (space === -1) {
      return undefined;
    }
    const length = Number.parseInt(data.slice(index, space), 10);
    if (!Number.isFinite(length) || length <= 0) {
      return undefined;
    }
    const record = data.slice(space + 1, index + length);
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") {
      return record.slice(equals + 1).replace(/\n$/, "");
    }
    index += length;
  }
  return undefined;
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  return buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/, "");
}

function stripArchiveRoot(path: string): string {
  return path.split("/").slice(1).join("/");
}
