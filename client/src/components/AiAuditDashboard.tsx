import type { ArchitectureGraph } from "@rav/shared";
import { useAiAudit } from "../hooks/useAiAudit";
import type { AuditError, AuditSection } from "../audit/types";
import { AuditLoadingState } from "./AuditLoadingState";
import { CollapsibleCard } from "./CollapsibleCard";
import { MarkdownRenderer } from "./MarkdownRenderer";

type AiAuditDashboardProps = {
  projectName: string;
  graph: ArchitectureGraph;
  enabled: boolean;
};

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

export function AiAuditDashboard({ projectName, graph, enabled }: AiAuditDashboardProps) {
  const { report, isLoading, error, retry, fromCache } = useAiAudit({
    projectName,
    graph,
    enabled
  });

  if (isLoading) {
    return <AuditLoadingState />;
  }

  if (error) {
    return <AuditErrorCard error={error} onRetry={retry} />;
  }

  if (!report) {
    return (
      <div className="audit-empty">
        <h2>AI Architecture Auditor</h2>
        <p>Load a project to generate an automated architecture audit.</p>
      </div>
    );
  }

  const scoreSection = report.sections.find((s: AuditSection) => s.id === "score");
  const otherSections = report.sections.filter((s: AuditSection) => s.id !== "score");

  return (
    <div className="audit-dashboard">
      <header className="audit-dashboard__header">
        <div>
          <p className="eyebrow">AI Software Architecture Auditor</p>
          <h2>{projectName}</h2>
          <p className="audit-dashboard__meta">
            Generated {new Date(report.generatedAt).toLocaleString()}
            {fromCache ? " · Restored from session cache" : ""}
            {" · "}
            Provider: {report.provider}
          </p>
        </div>
        <button className="audit-retry-button" type="button" onClick={retry}>
          Re-run Audit
        </button>
      </header>

      <div className="audit-score-hero">
        <div className="audit-score-hero__ring">
          <strong>{report.overallScore ?? graph.metrics.architectureScore}</strong>
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
        {otherSections.map((section: AuditSection, index: number) => (
          <AuditSectionCard key={section.id} section={section} defaultOpen={index < 3} />
        ))}
      </div>
    </div>
  );
}

function AuditSectionCard({
  section,
  defaultOpen
}: {
  section: AuditSection;
  defaultOpen: boolean;
}) {
  const icon = SECTION_ICONS[section.id] ?? "•";

  return (
    <CollapsibleCard
      title={section.title}
      defaultOpen={defaultOpen}
      badge={<span className="audit-section-icon">{icon}</span>}
    >
      <MarkdownRenderer content={section.content} />
    </CollapsibleCard>
  );
}

function AuditErrorCard({ error, onRetry }: { error: AuditError; onRetry: () => void }) {
  const titles: Record<AuditError["kind"], string> = {
    network: "Network Error",
    timeout: "Request Timed Out",
    "invalid-response": "Invalid AI Response",
    "empty-metadata": "Insufficient Metadata",
    unknown: "Audit Failed"
  };

  return (
    <div className="audit-error">
      <div className="audit-error__icon" aria-hidden="true">
        ✕
      </div>
      <h2>{titles[error.kind]}</h2>
      <p>{error.message}</p>
      {error.kind !== "empty-metadata" ? (
        <button className="primary-button" type="button" onClick={onRetry}>
          Retry Audit
        </button>
      ) : null}
    </div>
  );
}
