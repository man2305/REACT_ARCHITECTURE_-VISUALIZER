import type { SourceFile } from "@rav/shared";
import { gunzipSync } from "node:zlib";

const SOURCE_FILE_PATTERN = /\.(tsx|ts|jsx|js)$/i;
const IGNORED_PATH_PARTS = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".git/",
  "public/",
  "storybook-static/"
];
const MAX_FILES = 120;
const MAX_FILE_BYTES = 500_000;

type GitHubRepository = {
  default_branch: string;
  full_name: string;
};

type ParsedGitHubUrl = {
  owner: string;
  repo: string;
  ref?: string;
};

export async function fetchGitHubSourceFiles(repositoryUrl: string, requestedRef?: string): Promise<SourceFile[]> {
  const parsed = parseGitHubUrl(repositoryUrl);
  const repository = await requestGitHubJson<GitHubRepository>(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`
  );
  const ref = requestedRef?.trim() || parsed.ref || repository.default_branch;
  const files = await downloadRepositorySourceFiles(parsed.owner, parsed.repo, ref);

  if (files.length === 0) {
    throw new Error("No React source files were found in that repository.");
  }

  return files;
}

function parseGitHubUrl(repositoryUrl: string): ParsedGitHubUrl {
  let url: URL;

  try {
    url = new URL(repositoryUrl.trim());
  } catch {
    throw new Error("Enter a valid GitHub repository URL.");
  }

  if (url.hostname !== "github.com") {
    throw new Error("Only public github.com repository URLs are supported right now.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repoWithGit, view, ...rest] = parts;
  const repo = repoWithGit?.replace(/\.git$/i, "");

  if (!owner || !repo) {
    throw new Error("GitHub URL should look like https://github.com/owner/repo.");
  }

  return {
    owner,
    repo,
    ref: view === "tree" ? rest[0] : undefined
  };
}

async function requestGitHubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "react-architecture-visualizer"
    }
  });

  if (!response.ok) {
    throw new Error(await describeGitHubError(response));
  }

  return response.json() as Promise<T>;
}

async function downloadRepositorySourceFiles(owner: string, repo: string, ref: string): Promise<SourceFile[]> {
  const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  const response = await fetch(archiveUrl, {
    headers: {
      "User-Agent": "react-architecture-visualizer"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download repository archive from GitHub.`);
  }

  const compressed = Buffer.from(await response.arrayBuffer());
  return extractSourceFilesFromTar(gunzipSync(compressed));
}

async function describeGitHubError(response: Response): Promise<string> {
  if (response.status === 403) {
    return "GitHub rate limit reached. Try again later or use folder upload.";
  }

  if (response.status === 404) {
    return "GitHub repository or branch was not found. Make sure it is public.";
  }

  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? `GitHub request failed with status ${response.status}.`;
  } catch {
    return `GitHub request failed with status ${response.status}.`;
  }
}

function extractSourceFilesFromTar(tarBuffer: Buffer): SourceFile[] {
  const files: SourceFile[] = [];
  let offset = 0;

  while (offset + 512 <= tarBuffer.length && files.length < MAX_FILES) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = stripArchiveRoot([prefix, name].filter(Boolean).join("/"));
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const type = readTarString(header, 156, 1);

    offset += 512;

    if (
      type !== "5" &&
      size <= MAX_FILE_BYTES &&
      SOURCE_FILE_PATTERN.test(path) &&
      !IGNORED_PATH_PARTS.some((part) => path.includes(part))
    ) {
      const content = tarBuffer.subarray(offset, offset + size).toString("utf8");
      files.push({ path, content });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return files;
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
