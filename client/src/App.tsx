import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge as FlowEdge
} from "@xyflow/react";
import type { ArchitectureWarning, SourceFile } from "@rav/shared";
import { analyzeFiles, analyzeGitHubRepository } from "./api";
import { AiAuditDashboard } from "./components/AiAuditDashboard";
import { toFlowGraph } from "@rav/ui";
import { sampleProject } from "./sampleProject";
import type { ActiveView, LoadedGraph } from "./types";

const views: Array<{ id: ActiveView; label: string }> = [
  { id: "architecture", label: "Architecture" },
  { id: "imports", label: "Imports" },
  { id: "routes", label: "Routes" },
  { id: "hooks", label: "Hooks" },
  { id: "api", label: "API Calls" },
  { id: "audit", label: "AI Audit" }
];

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>("architecture");
  const [loadedGraph, setLoadedGraph] = useState<LoadedGraph | null>(null);
  const [isDark, setIsDark] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<{
    edgeId: string;
    source: string;
    target: string;
  } | null>(null);

  const flowGraph = useMemo(() => {
    if (!loadedGraph || activeView === "audit") {
      return { nodes: [], edges: [] };
    }

    return toFlowGraph(
      loadedGraph.graph,
      activeView,
      selectedConnection
        ? {
            edgeId: selectedConnection.edgeId,
            nodeIds: new Set([selectedConnection.source, selectedConnection.target])
          }
        : undefined,
      isDark,
      searchQuery
    );
  }, [activeView, loadedGraph, selectedConnection, isDark, searchQuery]);

  async function runAnalysis(name: string, files: SourceFile[]) {
    setIsAnalyzing(true);
    setError(null);

    try {
      const response = await analyzeFiles(files);
      setLoadedGraph({ name, graph: response.graph });
      setSelectedConnection(null);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "Failed to analyze project");
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleGitHubSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const repositoryUrl = githubUrl.trim();

    if (!repositoryUrl) {
      setError("Paste a public GitHub repository URL first.");
      return;
    }

    setIsAnalyzing(true);
    setError(null);

    try {
      const response = await analyzeGitHubRepository(repositoryUrl);
      const repositoryName = repositoryUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/i, "");
      setLoadedGraph({ name: repositoryName, graph: response.graph });
      setSelectedConnection(null);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "Failed to load GitHub repository");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function handleEdgeClick(_event: React.MouseEvent, edge: FlowEdge) {
    setSelectedConnection({
      edgeId: edge.id,
      source: edge.source,
      target: edge.target
    });
  }

  return (
    <main className={sidebarCollapsed ? `app${isDark ? " dark" : ""} app--sidebar-collapsed` : `app${isDark ? " dark" : ""}`}>
      <aside className={sidebarCollapsed ? "sidebar sidebar--collapsed" : "sidebar"}>
        {!sidebarCollapsed ? (
          <>
            <div>
              <p className="eyebrow">Static Analysis</p>
              <h1>React Architecture Visualizer</h1>
              <p className="summary">
                Load a public GitHub React project and inspect components, imports, routes, hooks, API calls,
                dead code signals, and dependency risks.
              </p>
            </div>

            <section className="control-section">
              <form className="github-form" onSubmit={(event) => void handleGitHubSubmit(event)}>
                <label htmlFor="github-url">GitHub URL</label>
                <input
                  id="github-url"
                  placeholder="https://github.com/owner/repo"
                  value={githubUrl}
                  onChange={(event) => setGithubUrl(event.target.value)}
                />
                <button className="primary-button" disabled={isAnalyzing} type="submit">
                  {isAnalyzing ? "Loading..." : "Load GitHub Repo"}
                </button>
              </form>

              <button
                className="primary-button"
                disabled={isAnalyzing}
                onClick={() => void runAnalysis("Sample project", sampleProject)}
              >
                {isAnalyzing ? "Analyzing..." : "Load Sample Project"}
              </button>
            </section>

            {loadedGraph ? <MetricsPanel loadedGraph={loadedGraph} /> : null}
            {error ? <div className="error-panel">{error}</div> : null}
          </>
        ) : (
          <div className="sidebar--collapsed-label">
            <span>{loadedGraph?.name ?? "RAV"}</span>
          </div>
        )}
        <button
          className="sidebar-toggle"
          type="button"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="project-name">{loadedGraph?.name ?? "No project loaded"}</span>
            <strong>{loadedGraph ? `${loadedGraph.graph.nodes.length} nodes` : "Ready"}</strong>
          </div>
          <div className="topbar-actions">
            {loadedGraph && activeView !== "audit" ? (
              <div className="graph-search">
                <input
                  type="text"
                  placeholder="Search components..."
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  className="graph-search__input"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    className="graph-search__clear"
                    onClick={() => setSearchQuery("")}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            ) : null}
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

            <label className="theme-switch" htmlFor="theme-toggle">
              <span>{isDark ? "Dark" : "Light"}</span>
              <input
                id="theme-toggle"
                checked={isDark}
                type="checkbox"
                onChange={(event) => setIsDark(event.target.checked)}
              />
              <span className="theme-switch__track" aria-hidden="true">
                <span className="theme-switch__thumb" />
              </span>
            </label>
          </div>
        </header>

        <ReactFlowProvider>
          <div className={activeView === "audit" ? "audit-shell" : "graph-shell"}>
            {loadedGraph && activeView === "audit" ? (
              <AiAuditDashboard
                projectName={loadedGraph.name}
                graph={loadedGraph.graph}
                enabled={activeView === "audit"}
              />
            ) : loadedGraph ? (
              <>
                <ReactFlow
                  nodes={flowGraph.nodes}
                  edges={flowGraph.edges}
                  fitView
                  minZoom={0.2}
                  onEdgeClick={handleEdgeClick}
                  onPaneClick={() => setSelectedConnection(null)}
                >
                  <Background />
                  <Controls />
                  <MiniMap pannable zoomable />
                </ReactFlow>
              </>
            ) : (
              <div className="empty-state">
                <h2>Start with a GitHub URL or the sample project.</h2>
                <p>
                  The first graph focuses on rendered component hierarchy. Switch tabs to inspect
                  imports, routes, hooks, API calls, and AI architecture audits.
                </p>
              </div>
            )}
          </div>
        </ReactFlowProvider>
      </section>
    </main>
  );
}

function MetricsPanel({ loadedGraph }: { loadedGraph: LoadedGraph }) {
  const { metrics, warnings } = loadedGraph.graph;
  const [severityFilter, setSeverityFilter] = useState<"all" | "error" | "warning" | "info">("all");
  const [expandedWarning, setExpandedWarning] = useState<number | null>(null);

  const filteredWarnings = useMemo(() => {
    if (severityFilter === "all") {
      return warnings;
    }
    return warnings.filter((w) => w.severity === severityFilter);
  }, [warnings, severityFilter]);

  const severityCounts = useMemo(() => {
    const counts = { error: 0, warning: 0, info: 0 };
    for (const w of warnings) {
      counts[w.severity as keyof typeof counts] += 1;
    }
    return counts;
  }, [warnings]);

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
        <h2>Warnings ({filteredWarnings.length})</h2>
        <div className="warning-filters">
          <button
            className={`warning-filter-btn ${severityFilter === "all" ? "active" : ""}`}
            type="button"
            onClick={() => setSeverityFilter("all")}
          >
            All ({warnings.length})
          </button>
          {severityCounts.error > 0 && (
            <button
              className={`warning-filter-btn warning-filter-btn--error ${severityFilter === "error" ? "active" : ""}`}
              type="button"
              onClick={() => setSeverityFilter("error")}
            >
              {severityCounts.error}
            </button>
          )}
          {severityCounts.warning > 0 && (
            <button
              className={`warning-filter-btn warning-filter-btn--warning ${severityFilter === "warning" ? "active" : ""}`}
              type="button"
              onClick={() => setSeverityFilter("warning")}
            >
              {severityCounts.warning}
            </button>
          )}
          {severityCounts.info > 0 && (
            <button
              className={`warning-filter-btn warning-filter-btn--info ${severityFilter === "info" ? "active" : ""}`}
              type="button"
              onClick={() => setSeverityFilter("info")}
            >
              {severityCounts.info}
            </button>
          )}
        </div>
        {filteredWarnings.length > 0 ? (
          filteredWarnings.map((warning, index) => (
            <WarningItem
              key={`${warning.type}-${warning.message}`}
              warning={warning}
              isExpanded={expandedWarning === index}
              onToggle={() => setExpandedWarning(expandedWarning === index ? null : index)}
            />
          ))
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

function WarningItem({
  warning,
  isExpanded,
  onToggle
}: {
  warning: ArchitectureWarning;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <article className={`warning warning-${warning.severity}`}>
      <button className="warning-header" type="button" onClick={onToggle}>
        <div className="warning-header__text">
          <strong>{warning.title}</strong>
          {!isExpanded ? <small className="warning-filepath">{warning.severity.toUpperCase()}</small> : null}
        </div>
        <span className={`warning-chevron ${isExpanded ? "open" : ""}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {isExpanded ? (
        <div className="warning-body">
          <p>{warning.message}</p>
          {warning.filePath ? <small className="warning-filepath">{warning.filePath}</small> : null}
          {warning.suggestion ? (
            <div className="warning-suggestion">
              <strong>Suggestion:</strong> <span>{warning.suggestion}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}


