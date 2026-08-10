import * as vscode from "vscode";
import type { ArchitectureGraph } from "@rav/shared";
import { analyzeWorkspace } from "./analyzer";
import { runAudit } from "./audit/auditRunner";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "./webview/protocol";

const DEBOUNCE_MS = 800;

let panel: vscode.WebviewPanel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
let currentName: string | undefined;
let currentGraph: ArchitectureGraph | undefined;
let watchEnabled = true;
let isAnalyzing = false;
let analysisTimer: NodeJS.Timeout | undefined;
let graphNonce = 0;

export function activate(context: vscode.ExtensionContext): void {
  watchEnabled = vscode.workspace
    .getConfiguration("reactArchitectureVisualizer")
    .get<boolean>("watch.enabled") ?? true;

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
      void runFullAnalysis();
      break;
    case "refresh":
      void runFullAnalysis();
      break;
    case "audit-request":
      await runAuditCommand();
      break;
    case "set-watch":
      watchEnabled = message.payload.enabled;
      if (watchEnabled) {
        setupWatcher(context);
      } else {
        watcher?.dispose();
        watcher = undefined;
      }
      void vscode.workspace
        .getConfiguration("reactArchitectureVisualizer")
        .update("watch.enabled", watchEnabled, vscode.ConfigurationTarget.Workspace);
      break;
    case "open-file": {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return;
      }
      try {
        const uri = vscode.Uri.joinPath(folder.uri, message.payload.path);
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

async function runFullAnalysis(): Promise<void> {
  if (!panel || isAnalyzing) {
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
        analyzedFileCount: result.analyzedFileCount
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
  }
}

async function runAuditCommand(): Promise<void> {
  if (!panel || !currentName || !currentGraph) {
    vscode.window.showInformationMessage(
      "Load a project first, then run the AI architecture audit."
    );
    return;
  }

  post({ type: "status", payload: { isAnalyzing: true } });
  const result = await runAudit(currentName, currentGraph);
  post({ type: "status", payload: { isAnalyzing: false } });

  if (result.report) {
    post({ type: "audit-result", payload: { report: result.report } });
  } else {
    post({ type: "audit-result", payload: { error: result.error } });
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
