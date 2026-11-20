import * as vscode from "vscode";
import type { ArchitectureGraph } from "@rav/shared";
import { analyzeWorkspace } from "./analyzer";
import { OPENAI_API_KEY_SECRET, runAudit } from "./audit/auditRunner";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "./webview/protocol";

const DEBOUNCE_MS = 800;

let panel: vscode.WebviewPanel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let secretStorage: vscode.SecretStorage | undefined;
let currentName: string | undefined;
let currentGraph: ArchitectureGraph | undefined;
let watchEnabled = true;
let isAnalyzing = false;
let pendingAnalysis = false;
let isAuditing = false;
let auditQueued = false;
let queuedAuditRequestId: string | undefined;
let analysisTimer: NodeJS.Timeout | undefined;
let graphNonce = 0;

export function activate(context: vscode.ExtensionContext): void {
  secretStorage = context.secrets;
  watchEnabled = vscode.workspace
    .getConfiguration("reactArchitectureVisualizer")
    .get<boolean>("watch.enabled") ?? true;

  // One-time migration: move a plaintext settings key (pre-0.1.3) into
  // SecretStorage and clear it from settings. See migrateApiKeyToSecrets.
  void migrateApiKeyToSecrets();

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = "$(repo) RAV";
  statusBarItem.tooltip = "React Architecture Visualizer — show architecture";
  statusBarItem.command = "reactArchitectureVisualizer.show";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("reactArchitectureVisualizer.show", () => {
      void createOrShowPanel(context);
    }),
    vscode.commands.registerCommand("reactArchitectureVisualizer.refresh", () => {
      void runFullAnalysis();
    }),
    vscode.commands.registerCommand("reactArchitectureVisualizer.runAudit", () => {
      void runAuditCommand();
    }),
    vscode.commands.registerCommand("reactArchitectureVisualizer.setOpenAiKey", () => {
      void setOpenAiKey();
    }),
    vscode.commands.registerCommand("reactArchitectureVisualizer.clearOpenAiKey", () => {
      void clearOpenAiKey();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("reactArchitectureVisualizer.watch.enabled")) {
        watchEnabled =
          vscode.workspace
            .getConfiguration("reactArchitectureVisualizer")
            .get<boolean>("watch.enabled") ?? true;
        if (watchEnabled) {
          setupWatcher(context);
        } else {
          watcher?.dispose();
          watcher = undefined;
        }
        // Keep the webview toggle in sync when the setting changes elsewhere.
        post({ type: "settings", payload: { watchEnabled } });
      }
    })
  );

  if (watchEnabled) {
    setupWatcher(context);
  }
}

function setupWatcher(context: vscode.ExtensionContext): void {
  if (watcher) {
    return;
  }
  watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx}");
  const schedule = () => {
    if (analysisTimer) {
      clearTimeout(analysisTimer);
    }
    analysisTimer = setTimeout(() => {
      analysisTimer = undefined;
      void runFullAnalysis();
    }, DEBOUNCE_MS);
  };
  watcher.onDidCreate(schedule, null, context.subscriptions);
  watcher.onDidChange(schedule, null, context.subscriptions);
  watcher.onDidDelete(schedule, null, context.subscriptions);
}

async function createOrShowPanel(context: vscode.ExtensionContext): Promise<void> {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "reactArchitectureVisualizer.panel",
    "React Architecture",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")]
    }
  );

  panel.webview.html = getHtml(panel.webview, context.extensionUri);

  panel.onDidDispose(
    () => {
      panel = undefined;
    },
    null,
    context.subscriptions
  );

  panel.webview.onDidReceiveMessage(
    (message: WebviewToExtensionMessage) => {
      void handleMessage(context, message);
    },
    null,
    context.subscriptions
  );

  void runFullAnalysis();
}

async function handleMessage(
  context: vscode.ExtensionContext,
  message: WebviewToExtensionMessage
): Promise<void> {
  switch (message.type) {
    case "ready":
      // The webview is listening now: send the real watch setting so the
      // toggle initializes from configuration instead of a hardcoded default.
      post({ type: "settings", payload: { watchEnabled } });
      void runFullAnalysis();
      break;
    case "refresh":
      void runFullAnalysis();
      break;
    case "audit-request":
      await runAuditCommand(message.payload.requestId);
      break;
    case "set-watch":
      watchEnabled = message.payload.enabled;
      if (watchEnabled) {
        setupWatcher(context);
      } else {
        watcher?.dispose();
        watcher = undefined;
      }
      // Global target: toggling must not create/modify the workspace's
      // .vscode/settings.json, and it works with no folder open.
      void vscode.workspace
        .getConfiguration("reactArchitectureVisualizer")
        .update("watch.enabled", watchEnabled, vscode.ConfigurationTarget.Global);
      break;
    case "open-file": {
      const uri = await resolveWorkspaceFile(message.payload.path);
      if (!uri) {
        vscode.window.showWarningMessage(
          `Could not open ${message.payload.path} (it may be outside the workspace).`
        );
        return;
      }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: true });
      } catch {
        vscode.window.showWarningMessage(
          `Could not open ${message.payload.path} (it may be outside the workspace).`
        );
      }
      break;
    }
  }
}

/**
 * Resolve a workspace-relative path to a file URI, searching ALL workspace
 * folders. In multi-root workspaces the analyzer prefixes paths with the
 * folder name ("Folder/src/App.tsx"); that prefix selects the folder
 * directly. Otherwise the first folder containing the path wins.
 * Returns undefined for paths that escape the workspace (".." segments)
 * or match no file.
 */
async function resolveWorkspaceFile(path: string): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) {
    return undefined;
  }

  const folderByName = folders.find((folder) => folder.name === segments[0]);
  const candidates: vscode.Uri[] = [];
  // First try the folder-prefixed interpretation ("Folder/src/App.tsx"),
  // which is how the analyzer emits paths in multi-root workspaces.
  if (folderByName && segments.length > 1) {
    candidates.push(
      vscode.Uri.joinPath(folderByName.uri, ...segments.slice(1))
    );
  }
  // Then try the plain relative path in every folder. This must include
  // folderByName too: a top-level directory can share the folder's name
  // (e.g. folder "src" with path "src/App.tsx"), where the prefixed
  // interpretation is wrong and only the plain path exists.
  for (const folder of folders) {
    candidates.push(vscode.Uri.joinPath(folder.uri, ...segments));
  }

  for (const uri of candidates) {
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      // Not in this folder — try the next candidate.
    }
  }
  return undefined;
}

async function runFullAnalysis(): Promise<void> {
  if (!panel) {
    return;
  }
  if (isAnalyzing) {
    // Don't drop the change: re-run once the current analysis finishes.
    pendingAnalysis = true;
    return;
  }
  isAnalyzing = true;
  post({ type: "status", payload: { isAnalyzing: true, error: undefined } });

  try {
    const result = await analyzeWorkspace();
    currentName = result.name;
    currentGraph = result.graph;
    graphNonce += 1;

    if (statusBarItem) {
      statusBarItem.text = `$(repo) ${result.name}`;
      statusBarItem.tooltip =
        `${result.graph.nodes.length} nodes · ${result.graph.warnings.length} warnings · ` +
        `score ${result.graph.metrics.architectureScore}`;
    }

    post({
      type: "graph",
      payload: {
        name: result.name,
        graph: result.graph,
        analyzedFileCount: result.analyzedFileCount,
        totalFileCount: result.totalFileCount,
        truncated: result.truncated,
        folderCount: result.folderCount
      }
    });
  } catch (error) {
    post({
      type: "status",
      payload: {
        isAnalyzing: false,
        error: error instanceof Error ? error.message : "Analysis failed."
      }
    });
  } finally {
    isAnalyzing = false;
    post({ type: "status", payload: { isAnalyzing: false } });
    if (pendingAnalysis) {
      pendingAnalysis = false;
      void runFullAnalysis();
    }
  }
}

async function runAuditCommand(requestId?: string): Promise<void> {
  if (!panel || !currentName || !currentGraph) {
    vscode.window.showInformationMessage(
      "Load a project first, then run the AI architecture audit."
    );
    return;
  }

  if (isAuditing) {
    // Queue at most one follow-up audit instead of running concurrently.
    // The webview stays in its loading state and receives this request's
    // result (with its requestId) when the queued run finishes.
    auditQueued = true;
    queuedAuditRequestId = requestId;
    return;
  }

  isAuditing = true;
  try {
    await runOneAudit(requestId);
    while (auditQueued) {
      auditQueued = false;
      const nextRequestId = queuedAuditRequestId;
      queuedAuditRequestId = undefined;
      if (!panel || !currentName || !currentGraph) {
        break;
      }
      await runOneAudit(nextRequestId);
    }
  } finally {
    isAuditing = false;
  }
}

/**
 * Run a single audit and ALWAYS answer the webview: every path posts an
 * audit-result (report or error) and resets the analyzing status, so no
 * throw can leave the UI wedged on its spinner.
 */
async function runOneAudit(requestId: string | undefined): Promise<void> {
  post({ type: "status", payload: { isAnalyzing: true } });
  try {
    const result = await runAudit(currentName!, currentGraph!, secretStorage!);
    if (result.report) {
      post({ type: "audit-result", payload: { report: result.report, requestId } });
    } else {
      post({ type: "audit-result", payload: { error: result.error, requestId } });
    }
  } catch (error) {
    post({
      type: "audit-result",
      payload: {
        error: {
          kind: "unknown",
          message: error instanceof Error ? error.message : "An unexpected error occurred."
        },
        requestId
      }
    });
  } finally {
    post({ type: "status", payload: { isAnalyzing: false } });
  }
}

async function setOpenAiKey(): Promise<void> {
  if (!secretStorage) {
    return;
  }
  const apiKey = await vscode.window.showInputBox({
    title: "React Architecture Visualizer: Set OpenAI API Key",
    prompt: "Enter your OpenAI API key. It is stored in VS Code SecretStorage, not in settings.",
    password: true,
    ignoreFocusOut: true
  });
  if (apiKey === undefined) {
    return;
  }
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    await secretStorage.delete(OPENAI_API_KEY_SECRET);
    vscode.window.showInformationMessage(
      "OpenAI API key cleared. Audits will use the local metadata analyzer."
    );
    return;
  }
  await secretStorage.store(OPENAI_API_KEY_SECRET, trimmed);
  vscode.window.showInformationMessage("OpenAI API key saved securely.");
}

async function clearOpenAiKey(): Promise<void> {
  if (!secretStorage) {
    return;
  }
  await secretStorage.delete(OPENAI_API_KEY_SECRET);
  vscode.window.showInformationMessage(
    "OpenAI API key cleared. Audits will use the local metadata analyzer."
  );
}

/**
 * One-time migration from the old plaintext settings key
 * (reactArchitectureVisualizer.openai.apiKey) to SecretStorage. If a key
 * exists in settings (user or workspace scope) and none is stored yet, it
 * is copied to secrets, cleared from every scope where it was set, and the
 * user is told what happened. Runs on every activation but is a no-op once
 * no settings key remains.
 */
async function migrateApiKeyToSecrets(): Promise<void> {
  if (!secretStorage) {
    return;
  }
  try {
    const config = vscode.workspace.getConfiguration("reactArchitectureVisualizer");
    const inspected = config.inspect<string>("openai.apiKey");
    const settingsKey =
      inspected?.workspaceValue?.trim() ||
      inspected?.globalValue?.trim() ||
      inspected?.defaultValue?.trim() ||
      "";
    if (settingsKey.length === 0) {
      return;
    }
    const existingSecret = await secretStorage.get(OPENAI_API_KEY_SECRET);
    if (!existingSecret) {
      await secretStorage.store(OPENAI_API_KEY_SECRET, settingsKey);
    }
    if (inspected?.workspaceValue !== undefined) {
      await config.update("openai.apiKey", undefined, vscode.ConfigurationTarget.Workspace);
    }
    if (inspected?.globalValue !== undefined) {
      await config.update("openai.apiKey", undefined, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage(
      "React Architecture Visualizer: your OpenAI API key was moved from settings into secure storage (SecretStorage). Manage it with the “Set/Clear OpenAI API Key” commands."
    );
  } catch {
    // Migration must never break activation; the key simply stays in
    // settings and the next activation retries.
  }
}

function post(message: ExtensionToWebviewMessage): void {
  void panel?.webview.postMessage(message);
}

function getNonce(): string {
  const text = "abcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += text.charAt(Math.floor(Math.random() * text.length));
  }
  return nonce;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));

  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>React Architecture</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function deactivate(): void {
  if (analysisTimer) {
    clearTimeout(analysisTimer);
  }
}
