<div align="center">

![React Architecture Visualizer](banner.png)

# React Architecture Visualizer

[![Version](https://img.shields.io/visual-studio-marketplace/v/manish-rai.react-architecture-visualizer?label=Marketplace&color=2563eb)](https://marketplace.visualstudio.com/items?itemName=manish-rai.react-architecture-visualizer)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/manish-rai.react-architecture-visualizer?color=7c3aed)](https://marketplace.visualstudio.com/items?itemName=manish-rai.react-architecture-visualizer)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/manish-rai.react-architecture-visualizer?color=10b981)](https://marketplace.visualstudio.com/items?itemName=manish-rai.react-architecture-visualizer)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

Scan the open React project and visualize its architecture — component hierarchy, imports, routes, hooks, API calls, warnings, and an AI architecture audit. All analysis runs **locally** in VS Code; no server or account required.

</div>

---

## Quick Start

1. Open a React project folder in VS Code (**File → Open Folder**) — the folder must contain `.tsx` / `.ts` / `.jsx` / `.js` files.
2. Press `Ctrl+Shift+P` (**⌘⇧P** on macOS) and run **React Architecture Visualizer: Show Architecture**.
3. Or just click the **`RAV`** button on the status bar.
4. The webview opens with a live graph of your project. It analyzes automatically — you don't need to click anything.

That's it. The graph builds from your local files only — nothing leaves your machine unless you enable the optional AI audit (see below).

---

## The Interface, Explained

Once the panel opens you see three areas:

### 1. Header bar
- **Project name + summary** — e.g. `App · 42 nodes · 18 components · 3 warnings · score 74`
- **Analyze button** — re-runs the scan manually
- **Auto-refresh toggle** — when on, the graph updates automatically whenever a source file changes (saved/deleted/created). Turn it off for very large projects to avoid churn.

### 2. Sidebar (metrics + warnings)
- **Architecture Score** — a 0–100 heuristic score of your project's structure.
- **Metric tiles** — Files, Components, Routes, Hooks, API Calls, Warnings.
- **Warnings list** — expandable findings. Filter by severity with the `All` / count buttons. Each warning shows:
  - **Title** (e.g. "God component detected")
  - **Message** explaining the problem
  - **File path button** — click to open that file
  - **Suggestion** — actionable fix where available

### 3. Main graph area
- The **interactive diagram** of your project. Drag to pan, scroll to zoom, use the controls (bottom-left) and minimap (bottom-right).
- **Click a node** → opens the source file in the editor.
- **Click an edge** → highlights the two connected nodes and that connection.
- **Click empty space** → clears the selection.

---

## The 6 View Tabs

Use the tabs at the top of the graph area to inspect different slices of your architecture:

| Tab | What it shows |
|---|---|
| **Architecture** | The component tree — which components render which (JSX parent/child relationships). |
| **Imports** | Files/import relationships across the codebase. |
| **Routes** | React Router route definitions and their components. |
| **Hooks** | Custom hooks and where they're used. |
| **API Calls** | Components that call APIs (`fetch`, `axios`, `useQuery`, etc.) and the endpoints involved. |
| **AI Audit** | The architecture audit report (see below). |

Edges are labeled in all views except **Architecture**, and API/route edges are animated so they stand out.

---

## Search & Filter

Type in the **search box** (top of the graph area) to dim everything that doesn't match — components and edges that match stay highlighted. Click **✕ Clear** to reset. This is the fastest way to find a specific component in a large project.

---

## AI Architecture Audit

The **AI Audit** tab produces a structured review of your project: overall score, strengths, weaknesses, maintainability, performance, scalability, refactoring opportunities, best practices, and a final verdict.

### Without a key (default, free)
No setup needed. The extension uses a **local metadata analyzer** that builds the report from your project's static metrics (component sizes, import counts, route/hook/API statistics, warning counts).

### With OpenAI (optional, richer analysis)
To get AI-written explanations and refactoring suggestions:

1. Open **Settings** (`Ctrl+,`) and search for `reactArchitectureVisualizer`.
2. Set `reactArchitectureVisualizer.openai.apiKey` to your OpenAI key.
3. (Optional) Change `reactArchitectureVisualizer.openai.model` (default `gpt-4o-mini`) or `reactArchitectureVisualizer.openai.apiUrl` if you use an OpenAI-compatible endpoint.
4. Switch to the **AI Audit** tab and click **Run Audit** (or **Re-run Audit**).

The audit report sections are collapsible; the first three open by default.

> **Privacy:** With a key set, your project's extracted metadata is sent to the configured endpoint. Without a key, everything stays local.

---

## Settings Reference

All settings are under the `reactArchitectureVisualizer.*` namespace (Settings → search `reactArchitectureVisualizer`).

| Setting | Default | Description |
|---|---|---|
| `reactArchitectureVisualizer.watch.enabled` | `true` | Auto re-analyze on file changes |
| `reactArchitectureVisualizer.analysis.maxFiles` | `120` | Max source files analyzed |
| `reactArchitectureVisualizer.analysis.maxFileBytes` | `500000` | Files larger than this (bytes) are skipped |
| `reactArchitectureVisualizer.openai.apiKey` | `""` | OpenAI key for AI audits (empty = local analyzer) |
| `reactArchitectureVisualizer.openai.model` | `gpt-4o-mini` | Chat model for audits |
| `reactArchitectureVisualizer.openai.apiUrl` | OpenAI endpoint | OpenAI-compatible endpoint |

---

## Commands

| Command (Command Palette `Ctrl+Shift+P`) | Title |
|---|---|
| `reactArchitectureVisualizer.show` | React Architecture Visualizer: Show Architecture |
| `reactArchitectureVisualizer.refresh` | React Architecture Visualizer: Refresh Analysis |
| `reactArchitectureVisualizer.runAudit` | React Architecture Visualizer: Run AI Audit |

You can also right-click a JavaScript/TypeScript/JSX/TSX file in the editor and choose **React Architecture Visualizer: Show Architecture** from the context menu.

---

## Requirements

- VS Code **1.86 or newer**
- Node.js 20+ — bundled into the extension, nothing to install

## Supported file types

- `.tsx`, `.ts`, `.jsx`, `.js`
- Skips `node_modules`, `dist`, `build`, `out`, `.git`, `.next`, `.output`, `coverage`

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "No workspace folder is open" | Open a project folder first, then run the command. |
| Graph looks empty | Confirm the folder has `.tsx`/`.jsx` files, then click **Analyze**. |
| Very large repo analysis is slow | Lower `analysis.maxFiles`, or disable **Auto-refresh**. |
| AI audit errors | No key set → it uses the local analyzer automatically. With a key, check it's valid and the model/endpoint are reachable. |
| Warnings about big files | `analysis.maxFileBytes` (default 500 KB) skips very large files — raise it if you need them analyzed. |

---

## Development

```
npm install
npm run build -w vscode-extension   # or press F5 with the repo open
npm run package                      # build the .vsix from vscode-extension/
```

## License

MIT
