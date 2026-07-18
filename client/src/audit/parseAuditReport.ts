import type { ArchitectureAuditReport, AuditSection } from "./types";

const SECTION_ALIASES: Record<string, string> = {
  "overall architecture score": "score",
  "executive summary": "summary",
  "architecture strengths": "strengths",
  "architecture weaknesses": "weaknesses",
  "maintainability review": "maintainability",
  "performance risks": "performance",
  "scalability review": "scalability",
  "refactoring opportunities": "refactoring",
  "react best practices": "best-practices",
  "engineering recommendations": "recommendations",
  "final verdict": "verdict"
};

function normalizeTitle(title: string): string {
  return title
    .replace(/^\d+\.\s*/, "")
    .replace(/\*+/g, "")
    .trim()
    .toLowerCase();
}

function sectionId(title: string): string {
  const normalized = normalizeTitle(title);
  return SECTION_ALIASES[normalized] ?? normalized.replace(/[^a-z0-9]+/g, "-");
}

export function parseAuditMarkdown(
  markdown: string,
  projectName: string,
  provider: string
): ArchitectureAuditReport {
  const sections: AuditSection[] = [];
  const headingPattern = /^##\s+(.+)$/gm;
  const matches = [...markdown.matchAll(headingPattern)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const title = match[1].trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index! : markdown.length;
    const content = markdown.slice(start, end).trim();

    sections.push({
      id: sectionId(title),
      title: title.replace(/\*+/g, "").trim(),
      content
    });
  }

  if (sections.length === 0) {
    sections.push({
      id: "full-report",
      title: "Architecture Audit",
      content: markdown.trim()
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    projectName,
    rawMarkdown: markdown,
    sections,
    overallScore: extractOverallScore(markdown, sections),
    provider
  };
}

function extractOverallScore(markdown: string, sections: AuditSection[]): number | null {
  const scoreSection = sections.find((section) => section.id === "score");
  const source = scoreSection?.content ?? markdown;

  const patterns = [
    /\*\*(\d{1,3})\s*\/\s*100\*\*/,
    /(\d{1,3})\s*\/\s*100/,
    /score[:\s]+(\d{1,3})/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (value >= 0 && value <= 100) {
        return value;
      }
    }
  }

  return null;
}

export function isValidAuditResponse(markdown: string): boolean {
  const trimmed = markdown.trim();
  if (trimmed.length < 100) {
    return false;
  }

  const hasHeadings = /^##\s+/m.test(trimmed);
  const hasContent = trimmed.split("\n").filter((line) => line.trim().length > 0).length >= 5;

  return hasHeadings && hasContent;
}
