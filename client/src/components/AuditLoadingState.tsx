export function AuditLoadingState() {
  return (
    <div className="audit-loading">
      <div className="audit-loading__spinner" aria-hidden="true" />
      <h2>AI is reviewing your software architecture...</h2>
      <p>Analyzing component structure, dependencies, and architecture patterns.</p>
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
