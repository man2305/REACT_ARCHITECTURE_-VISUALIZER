import { useState, type ReactNode } from "react";

type CollapsibleCardProps = {
  title: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
};

export function CollapsibleCard({ title, defaultOpen = true, badge, children }: CollapsibleCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <article className="audit-card">
      <button
        className="audit-card__header"
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="audit-card__title">{title}</span>
        <span className="audit-card__actions">
          {badge}
          <span className={`audit-card__chevron ${isOpen ? "open" : ""}`} aria-hidden="true">
            ▾
          </span>
        </span>
      </button>
      {isOpen ? <div className="audit-card__body">{children}</div> : null}
    </article>
  );
}
