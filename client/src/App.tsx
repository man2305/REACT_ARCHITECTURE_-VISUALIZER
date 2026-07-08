import { useMemo, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import type { ArchitectureWarning, SourceFile } from "@rav/shared";
import { analyzeFiles } from "./api";
import { readProjectFiles } from "./fileUpload";
import { toFlowGraph } from "./graphProjection";
import { sampleProject } from "./sampleProject";
import type { ActiveView, LoadedGraph } from "./types";

const views: Array<{ id: ActiveView; label: string }> = [
  { id: "architecture", label: "Architecture" },
  { id: "imports", label: "Imports" },
  { id: "routes", label: "Routes" },
  { id: "hooks", label: "Hooks" },
  { id: "api", label: "API Calls" }
];

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>("architecture");
  const [loadedGraph, setLoadedGraph] = useState<LoadedGraph | null>(null);
  const [isDark, setIsDark] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flowGraph = useMemo(() => {
    if (!loadedGraph) {
      return { nodes: [], edges: [] };
    }

    return toFlowGraph(loadedGraph.graph, activeView);
  }, [activeView, loadedGraph]);

  async function runAnalysis(name: string, files: SourceFile[]) {
    setIsAnalyzing(true);
    setError(null);

    try {
      const response = await analyzeFiles(files);
      setLoadedGraph({ name, graph: response.graph });
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "Failed to analyze project");
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleFolderUpload(fileList: FileList | null) {
    if (!fileList?.length) {
      return;
    }

    const files = await readProjectFiles(fileList);
    if (files.length === 0) {
      setError("No React source files found in that folder.");
      return;
    }

    await runAnalysis("Uploaded project", files);
  }

  return (
    <main className={isDark ? "app dark" : "app"}>
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Static Analysis</p>
          <h1>React Architecture Visualizer</h1>
          <p className="summary">
            Upload a React project and inspect components, imports, routes, hooks, API calls,
            dead code signals, and dependency risks.
          </p>
        </div>

        <section className="control-section">
          <label className="upload-zone">
            <input
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is supported by Chromium browsers.
              webkitdirectory=""
              onChange={(event) => void handleFolderUpload(event.target.files)}
            />
            <span>Upload Folder</span>
            <small>Reads source files locally, then sends text to the analyzer.</small>
          </label>

          <button
            className="primary-button"
            disabled={isAnalyzing}
            onClick={() => void runAnalysis("Sample project", sampleProject)}
          >
            {isAnalyzing ? "Analyzing..." : "Load Sample Project"}
          </button>

          <button className="ghost-button" onClick={() => setIsDark((value) => !value)}>
            {isDark ? "Light Mode" : "Dark Mode"}
          </button>
        </section>

        {loadedGraph ? <MetricsPanel loadedGraph={loadedGraph} /> : <EmptyPanel />}
        {error ? <div className="error-panel">{error}</div> : null}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="project-name">{loadedGraph?.name ?? "No project loaded"}</span>
            <strong>{loadedGraph ? `${loadedGraph.graph.nodes.length} nodes` : "Ready"}</strong>
          </div>
          <nav className="view-tabs" aria-label="Graph views">
            {views.map((view) => (
              <button
                key={view.id}
                className={activeView === view.id ? "active" : ""}
                onClick={() => setActiveView(view.id)}
              >
                {view.label}
              </button>
            ))}
          </nav>
        </header>

        <ReactFlowProvider>
          <div className="graph-shell">
            {loadedGraph ? (
              <ReactFlow nodes={flowGraph.nodes} edges={flowGraph.edges} fitView minZoom={0.2}>
                <Background />
                <Controls />
                <MiniMap pannable zoomable />
              </ReactFlow>
            ) : (
              <div className="empty-state">
                <h2>Start with a folder or the sample project.</h2>
                <p>
                  The first graph focuses on rendered component hierarchy. Switch tabs to inspect
                  imports, routes, hooks, and API calls.
                </p>
              </div>
            )}
          </div>
        </ReactFlowProvider>
      </section>
    </main>
  );
}

function EmptyPanel() {
  return (
    <section className="info-panel">
      <h2>MVP scope</h2>
      <p>
        This build covers the core placement-worthy pieces: AST parsing, relationship extraction,
        graph generation, and React Flow visualization.
      </p>
    </section>
  );
}

function MetricsPanel({ loadedGraph }: { loadedGraph: LoadedGraph }) {
  const { metrics, warnings } = loadedGraph.graph;
  const topWarnings = warnings.slice(0, 5);

  return (
    <section className="metrics-panel">
      <div className="score-card">
        <span>Architecture Score</span>
        <strong>{metrics.architectureScore}</strong>
      </div>
      <div className="metric-grid">
        <Metric label="Files" value={metrics.fileCount} />
        <Metric label="Components" value={metrics.componentCount} />
        <Metric label="Routes" value={metrics.routeCount} />
        <Metric label="Hooks" value={metrics.hookCount} />
        <Metric label="API Calls" value={metrics.apiCallCount} />
        <Metric label="Warnings" value={metrics.warningCount} />
      </div>

      <div className="warnings-list">
        <h2>Warnings</h2>
        {topWarnings.length > 0 ? (
          topWarnings.map((warning) => <WarningItem key={`${warning.type}-${warning.message}`} warning={warning} />)
        ) : (
          <p>No warnings found.</p>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WarningItem({ warning }: { warning: ArchitectureWarning }) {
  return (
    <article className={`warning warning-${warning.severity}`}>
      <strong>{warning.title}</strong>
      <p>{warning.message}</p>
      {warning.filePath ? <small>{warning.filePath}</small> : null}
    </article>
  );
}
