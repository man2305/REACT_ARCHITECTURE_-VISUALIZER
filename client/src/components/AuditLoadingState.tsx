type AuditLoadingStateProps = {
  /** "ai" while a server AI audit is in flight, "fallback" while the local rule-based summary is generated. */
  mode?: "ai" | "fallback";
};

export function AuditLoadingState({ mode = "ai" }: AuditLoadingStateProps) {
  const isFallback = mode === "fallback";

  return (
    <div className="audit-loading">
      <div className="audit-loading__spinner" aria-hidden="true" />
      <h2>
        {isFallback
          ? "Generating rule-based summary..."
          : "AI is reviewing your software architecture..."}
      </h2>
      <p>
        {isFallback
          ? "OpenAI is not configured, so this summary is built from static analysis only."
          : "Analyzing component structure, dependencies, and architecture patterns."}
      </p>
      <div className="audit-loading__steps">
        <LoadingStep label="Generating project metadata" delay={0} />
        <LoadingStep label="Evaluating component hierarchy" delay={400} />
        <LoadingStep label="Assessing maintainability signals" delay={800} />
        <LoadingStep label="Preparing architecture audit report" delay={1200} />
      </div>
    </div>
  );
}

function LoadingStep({ label, delay }: { label: string; delay: number }) {
  return (
    <div className="audit-loading__step" style={{ animationDelay: `${delay}ms` }}>
      <span className="audit-loading__dot" />
      <span>{label}</span>
    </div>
  );
}
