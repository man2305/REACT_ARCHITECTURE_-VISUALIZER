import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge as FlowEdge,
  type Node as FlowNode
} from "@xyflow/react";
import type { ArchitectureGraph, ArchitectureWarning } from "@rav/shared";
import type { ArchitectureAuditReport, AuditError } from "@rav/audit";
import { CollapsibleCard, MarkdownRenderer, toFlowGraph } from "@rav/ui";
import type { ActiveView } from "@rav/ui";
import { vscodeApi } from "./vscodeApi";
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage
} from "./protocol";

const views: Array<{ id: ActiveView; label: string }> = [
  { id: "architecture", label: "Architecture" },
  { id: "imports", label: "Imports" },
  { id: "routes", label: "Routes" },
  { id: "hooks", label: "Hooks" },
  { id: "api", label: "API Calls" },
  { id: "audit", label: "AI Audit" }
];

type SelectedConnection = {
  edgeId: string;
  source: string;
  target: string;
};

function post(message: WebviewToExtensionMessage): void {
  vscodeApi?.postMessage(message);
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `audit-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function App() {
  const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
  const [projectName, setProjectName] = useState("");
  const [analyzedFileCount, setAnalyzedFileCount] = useState(0);
  const [totalFileCount, setTotalFileCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [folderCount, setFolderCount] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("architecture");
  const [searchQuery, setSearchQuery] = useState("");
  const [watchEnabled, setWatchEnabled] = useState(true);
  const [selectedConnection, setSelectedConnection] = useState<SelectedConnection | null>(null);
  const [report, setReport] = useState<ArchitectureAuditReport | null>(null);
  const [auditError, setAuditError] = useState<AuditError | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const latestAuditRequestId = useRef<string | null>(null);

  useEffect(() => {
    post({ type: "ready" });
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent<ExtensionToWebviewMessage>) {
      const message = event.data;
      if (!message || typeof message.type !== "string") {
        return;
      }
      switch (message.type) {
        case "graph":
          setProjectName(message.payload.name);
          setGraph(message.payload.graph);
          setAnalyzedFileCount(message.payload.analyzedFileCount);
          setTotalFileCount(message.payload.totalFileCount);
          setTruncated(message.payload.truncated);
          setFolderCount(message.payload.folderCount);
          setSelectedConnection(null);
          break;
        case "status":
          setIsAnalyzing(message.payload.isAnalyzing);
          if (message.payload.error !== undefined) {
            setError(message.payload.error);
          }
          break;
        case "settings":
          setWatchEnabled(message.payload.watchEnabled);
          break;
        case "audit-result": {
          // Drop stale results: only the latest request's response (or a
          // palette-triggered audit, which carries no requestId) is shown.
          const requestId = message.payload.requestId;
          if (requestId !== undefined && requestId !== latestAuditRequestId.current) {
            break;
          }
          setAuditLoading(false);
          if ("report" in message.payload) {
            setReport(message.payload.report);
            setAuditError(null);
          } else {
            setAuditError(message.payload.error);
          }
          break;
        }
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Audits run ONLY when the user clicks Run Audit / Re-run (see E-M3).
  // There used to be an auto-run effect here that fired a paid OpenAI call
  // on every re-analysis while the Audit tab was open.
  function requestAudit(): void {
    const requestId = createRequestId();
    latestAuditRequestId.current = requestId;
    setAuditLoading(true);
    setAuditError(null);
    post({ type: "audit-request", payload: { requestId } });
  }

  const flowGraph = useMemo(() => {
    if (!graph || activeView === "audit") {
      return { nodes: [], edges: [] };
    }
    return toFlowGraph(
      graph,
      activeView,
      selectedConnection
        ? {
            edgeId: selectedConnection.edgeId,
            nodeIds: new Set([selectedConnection.source, selectedConnection.target])
          }
        : undefined,
      true,
      searchQuery
    );
  }, [graph, activeView, selectedConnection, searchQuery]);

  function handleEdgeClick(_event: React.MouseEvent, edge: FlowEdge) {
    setSelectedConnection({
      edgeId: edge.id,
      source: edge.source,
      target: edge.target
    });
  }

  function handleNodeClick(_event: React.MouseEvent, node: FlowNode) {
    if (!graph) {
      return;
    }
    const filePath = graph.nodes.find((n) => n.id === node.id)?.filePath;
    if (filePath) {
      post({ type: "open-file", payload: { path: filePath } });
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-info">
          <span className="app__project-name">{projectName || "No project loaded"}</span>
          {graph ? (
            <span className="app__meta">
              {graph.nodes.length} nodes · {graph.components.length} components ·{" "}
              {graph.warnings.length} warnings · score {graph.metrics.architectureScore}
              {totalFileCount > 0 ? (
                <>
                  {" · "}Analyzed {analyzedFileCount} of {totalFileCount} files
                </>
              ) : null}
              {folderCount > 1 ? (
                <>
                  {" · "}{folderCount} workspace folders
                </>
              ) : null}
            </span>
          ) : (
            <span className="app__meta">{isAnalyzing ? "Analyzing workspace..." : "Open a React project to begin"}</span>
          )}
        </div>
        <div className="app__header-actions">
          <button
            className="btn"
            type="button"
            disabled={isAnalyzing}
            onClick={() => post({ type: "refresh" })}
          >
            {isAnalyzing ? "Analyzing…" : "Analyze"}
          </button>
          <label className="watch-toggle">
            <input
              type="checkbox"
              checked={watchEnabled}
              onChange={(event) => {
                const enabled = event.target.checked;
                setWatchEnabled(enabled);
                post({ type: "set-watch", payload: { enabled } });
              }}
            />
            <span>Auto-refresh</span>
          </label>
        </div>
      </header>

      {graph && truncated ? (
        <div className="truncation-banner" role="alert">
          Showing the first {analyzedFileCount} of {totalFileCount} files — raise{" "}
          <code>analysis.maxFiles</code> in settings to analyze the whole project.
        </div>
      ) : null}

      <div className="app__body">
        <aside className="sidebar">
          {graph ? (
            <MetricsPanel graph={graph} onOpenFile={(path) => post({ type: "open-file", payload: { path } })} />
          ) : error ? (
            <div className="empty-card">
              <strong>Analysis failed</strong>
              <p>{error}</p>
              <button className="btn" type="button" onClick={() => post({ type: "refresh" })}>
                Retry
              </button>
            </div>
          ) : (
            <div className="empty-card">
              <strong>React Architecture Visualizer</strong>
              <p>
                {isAnalyzing
                  ? "Reading your workspace and building the dependency graph…"
                  : "This extension scans the open workspace (TS/TSX/JS/JSX) and visualizes components, imports, routes, hooks, and API calls."}
              </p>
            </div>
          )}
        </aside>

        <section className="workspace">
          <nav className="view-tabs" aria-label="Graph views">
            {views.map((view) => (
              <button
                key={view.id}
                type="button"
                className={activeView === view.id ? "active" : ""}
                onClick={() => setActiveView(view.id)}
              >
                {view.label}
              </button>
            ))}
            {graph && activeView !== "audit" ? (
              <div className="graph-search">
                <input
                  type="text"
                  placeholder="Search components..."
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  className="graph-search__input"
                  aria-label="Search components"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    className="graph-search__clear"
                    onClick={() => setSearchQuery("")}
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            ) : null}
          </nav>

          {activeView === "audit" ? (
            <AuditPanel
              projectName={projectName}
              report={report}
              error={auditError}
              isLoading={auditLoading}
              hasGraph={Boolean(graph)}
              onRun={requestAudit}
            />
          ) : graph ? (
            <div className="graph-shell">
              <ReactFlow
                nodes={flowGraph.nodes}
                edges={flowGraph.edges}
                fitView
                minZoom={0.2}
                onEdgeClick={handleEdgeClick}
                onNodeClick={handleNodeClick}
                onPaneClick={() => setSelectedConnection(null)}
              >
                <Background />
                <Controls />
                <MiniMap pannable zoomable />
              </ReactFlow>
              {searchQuery ? (
                <button
                  className="search-clear"
                  type="button"
                  onClick={() => setSearchQuery("")}
                  title="Clear search"
                >
                  ✕ Clear ({searchQuery})
                </button>
              ) : null}
            </div>
          ) : (
            <div className="empty-state">
              <h2>Waiting for the workspace…</h2>
              <p>Analysis runs automatically when a workspace folder is open.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MetricsPanel({
  graph,
  onOpenFile
}: {
  graph: ArchitectureGraph;
  onOpenFile: (path: string) => void;
}) {
  const { metrics, warnings } = graph;
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
    <div className="metrics-panel">
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
              onOpenFile={onOpenFile}
            />
          ))
        ) : (
          <p className="muted">No warnings found.</p>
        )}
      </div>
    </div>
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
  onToggle,
  onOpenFile
}: {
  warning: ArchitectureWarning;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <article className={`warning warning-${warning.severity}`}>
      <button className="warning-header" type="button" onClick={onToggle}>
        <div className="warning-header__text">
          <strong>{warning.title}</strong>
          {!isExpanded ? (
            <small className="warning-filepath">{warning.severity.toUpperCase()}</small>
          ) : null}
        </div>
        <span className={`warning-chevron ${isExpanded ? "open" : ""}`} aria-hidden="true">
          ▾
        </span>
      </button>
      {isExpanded ? (
        <div className="warning-body">
          <p>{warning.message}</p>
          {warning.filePath ? (
            <button
              className="link-button"
              type="button"
              onClick={() => onOpenFile(warning.filePath!)}
            >
              {warning.filePath}
            </button>
          ) : null}
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

const SECTION_ICONS: Record<string, string> = {
  score: "◆",
  summary: "◈",
  strengths: "✓",
  weaknesses: "⚠",
  maintainability: "⚙",
  performance: "⚡",
  scalability: "↗",
  refactoring: "⟳",
  "best-practices": "◉",
  recommendations: "→",
  verdict: "◼"
};

function AuditPanel({
  projectName,
  report,
  error,
  isLoading,
  hasGraph,
  onRun
}: {
  projectName: string;
  report: ArchitectureAuditReport | null;
  error: AuditError | null;
  isLoading: boolean;
  hasGraph: boolean;
  onRun: () => void;
}) {
  if (!hasGraph) {
    return (
      <div className="empty-state">
        <h2>AI Architecture Auditor</h2>
        <p>Load a project to generate an automated architecture audit.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="empty-state">
        <div className="spinner" aria-hidden="true" />
        <h2>Auditing architecture…</h2>
        <p>
          {error
            ? error.message
            : "Generating a structured review of your component graph, warnings, and metrics."}
        </p>
      </div>
    );
  }

  if (error) {
    const titles: Record<AuditError["kind"], string> = {
      network: "Network Error",
      timeout: "Request Timed Out",
      "invalid-response": "Invalid AI Response",
      "empty-metadata": "Insufficient Metadata",
      unknown: "Audit Failed"
    };
    return (
      <div className="empty-state">
        <h2>{titles[error.kind]}</h2>
        <p>{error.message}</p>
        {error.kind !== "empty-metadata" ? (
          <button className="btn" type="button" onClick={onRun}>
            Retry Audit
          </button>
        ) : null}
      </div>
    );
  }

  if (!report) {
    return (
      <div className="empty-state">
        <h2>AI Architecture Auditor</h2>
        <p>
          Click below to run the audit. Uses OpenAI if a key is set (Command Palette → “React
          Architecture Visualizer: Set OpenAI API Key”), otherwise a local rule-based summary.
        </p>
        <button className="btn primary" type="button" onClick={onRun}>
          Run Audit
        </button>
      </div>
    );
  }

  const scoreSection = report.sections.find((s) => s.id === "score");
  const otherSections = report.sections.filter((s) => s.id !== "score");

  return (
    <div className="audit-dashboard">
      <header className="audit-dashboard__header">
        <div>
          <p className="eyebrow">AI Software Architecture Auditor</p>
          <h2>{projectName}</h2>
          <p className="audit-dashboard__meta">
            Generated {new Date(report.generatedAt).toLocaleString()} · Provider: {report.provider}
          </p>
        </div>
        <button className="btn" type="button" onClick={onRun}>
          Re-run Audit
        </button>
      </header>

      {report.provider === "metadata-analyzer" ? (
        <p className="audit-notice">
          Rule-based summary — no AI model was used for this report. Set an OpenAI key (Command
          Palette → “React Architecture Visualizer: Set OpenAI API Key”) for an AI-written audit.
        </p>
      ) : null}

      <div className="audit-score-hero">
        <div className="audit-score-hero__ring">
          <strong>{report.overallScore ?? "—"}</strong>
          <span>/ 100</span>
        </div>
        <div className="audit-score-hero__details">
          <h3>Overall Architecture Score</h3>
          {scoreSection ? (
            <MarkdownRenderer content={scoreSection.content} />
          ) : (
            <p>Score derived from static analysis and AI assessment.</p>
          )}
        </div>
      </div>

      <div className="audit-sections">
        {otherSections.map((section, index) => (
          <CollapsibleCard
            key={section.id}
            title={section.title}
            defaultOpen={index < 3}
            badge={<span className="audit-section-icon">{SECTION_ICONS[section.id] ?? "•"}</span>}
          >
            <MarkdownRenderer content={section.content} />
          </CollapsibleCard>
        ))}
      </div>
    </div>
  );
}
