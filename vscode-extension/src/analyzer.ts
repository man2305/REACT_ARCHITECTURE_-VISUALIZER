import * as vscode from "vscode";
import { analyzeProject } from "@rav/parser";
import type { ArchitectureGraph, SourceFile } from "@rav/shared";

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx}";
const EXCLUDE_GLOB = "**/{node_modules,dist,build,out,.git,.next,.output,coverage}/**";

function isTextLike(content: string): boolean {
  if (content.includes("\u0000")) {
    return false;
  }
  for (const line of content.split("\n").slice(0, 50)) {
    if (line.length > 2000) {
      return false;
    }
  }
  return true;
}

export type AnalysisResult = {
  name: string;
  graph: ArchitectureGraph;
  analyzedFileCount: number;
};

export async function analyzeWorkspace(): Promise<AnalysisResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("No workspace folder is open. Open a React project and try again.");
  }

  const config = vscode.workspace.getConfiguration("reactArchitectureVisualizer");
  const maxFiles = config.get<number>("analysis.maxFiles") ?? 120;
  const maxFileBytes = config.get<number>("analysis.maxFileBytes") ?? 500_000;

  const root = folders[0];
  const uris = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB, 5000);

  const files: SourceFile[] = [];
  for (const uri of uris) {
    if (files.length >= maxFiles) {
      break;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxFileBytes) {
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString("utf8");
      if (!isTextLike(content)) {
        continue;
      }
      const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
      files.push({ path: relative, content });
    } catch {
      // Skip files that cannot be read (deleted between listing and read, etc.)
    }
  }

  const graph = analyzeProject(files);
  return { name: root.name, graph, analyzedFileCount: files.length };
}
