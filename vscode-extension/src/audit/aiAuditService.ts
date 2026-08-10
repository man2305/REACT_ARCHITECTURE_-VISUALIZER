import { AUDIT_SYSTEM_PROMPT, buildAuditUserPrompt } from "../../../client/src/audit/aiAuditPrompt";
import type { AiAuditProvider, ProjectAuditMetadata } from "../../../client/src/audit/types";

const DEFAULT_TIMEOUT_MS = 60_000;

export class AuditServiceError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "invalid-response" | "configuration"
  ) {
    super(message);
    this.name = "AuditServiceError";
  }
}

export type OpenAiConfig = {
  apiKey: string;
  apiUrl: string;
  model: string;
  timeoutMs?: number;
};

export function createOpenAiProvider(config: OpenAiConfig): AiAuditProvider {
  return {
    name: "openai",
    async generateAudit(metadata: ProjectAuditMetadata): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetch(config.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            messages: [
              { role: "system", content: AUDIT_SYSTEM_PROMPT },
              { role: "user", content: buildAuditUserPrompt(metadata) }
            ]
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new AuditServiceError(
            `AI request failed (${response.status}): ${errorText.slice(0, 200)}`,
            "network"
          );
        }

        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = body.choices?.[0]?.message?.content?.trim();

        if (!content) {
          throw new AuditServiceError("AI returned an empty response.", "invalid-response");
        }

        return content;
      } catch (error) {
        if (error instanceof AuditServiceError) {
          throw error;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new AuditServiceError("AI audit request timed out.", "timeout");
        }
        throw new AuditServiceError(
          error instanceof Error ? error.message : "Network request failed.",
          "network"
        );
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

export function createMetadataProvider(): AiAuditProvider {
  return {
    name: "metadata-analyzer",
    async generateAudit(metadata: ProjectAuditMetadata): Promise<string> {
      const { statistics, architectureMetrics, warnings, unusedComponents, circularDependencies } =
        metadata;

      const strengths: string[] = [];
      const weaknesses: string[] = [];

      if (metadata.architectureScore >= 75) {
        strengths.push(`Strong architecture score of ${metadata.architectureScore}/100.`);
      }
      if (statistics.components > 0 && statistics.components <= 30) {
        strengths.push("Manageable component count supports clear ownership.");
      }
      if (architectureMetrics.averageComponentSize <= 150) {
        strengths.push(
          `Average component size (${architectureMetrics.averageComponentSize} lines) indicates reasonable granularity.`
        );
      }
      if (circularDependencies.length === 0) {
        strengths.push("No circular dependencies detected in the analyzed graph.");
      }
      if (unusedComponents.length === 0) {
        strengths.push("No unused components detected among analyzed files.");
      }

      if (architectureMetrics.largestComponent !== "N/A") {
        const largest = metadata.largestComponents[0];
        if (largest && largest.lines >= 300) {
          weaknesses.push(
            `${largest.name} (${largest.lines} lines in ${largest.file}) exceeds recommended size thresholds.`
          );
        }
      }
      if (circularDependencies.length > 0) {
        weaknesses.push(
          `${circularDependencies.length} circular dependency chain(s) detected — e.g. ${circularDependencies[0]?.join(" → ")}.`
        );
      }
      if (unusedComponents.length > 0) {
        weaknesses.push(
          `${unusedComponents.length} potentially unused component(s): ${unusedComponents.slice(0, 5).join(", ")}.`
        );
      }
      if (architectureMetrics.deepestComponentTree > 5) {
        weaknesses.push(
          `Component tree depth of ${architectureMetrics.deepestComponentTree} may increase rendering complexity.`
        );
      }
      if (statistics.apiCalls > statistics.components) {
        weaknesses.push("API call density is high relative to component count.");
      }

      if (strengths.length === 0) {
        strengths.push("Project structure was successfully analyzed and metadata is available for review.");
      }
      if (weaknesses.length === 0) {
        weaknesses.push("No critical structural warnings were flagged by static analysis.");
      }

      const score = metadata.architectureScore;

      return `# Architecture Audit Report

## Overall Architecture Score

**${score}/100**

Based on static analysis metadata: ${statistics.components} components across ${statistics.totalFiles} files with ${warnings.length} warning(s).

## Executive Summary

**${metadata.projectName}** is a React project with ${statistics.components} components, ${statistics.routes} routes, ${statistics.hooks} unique hooks, and ${statistics.apiCalls} API calls. The static analysis architecture score is ${score}/100.

## Architecture Strengths

${strengths.map((s) => `- ${s}`).join("\n")}

## Architecture Weaknesses

${weaknesses.map((w) => `- ${w}`).join("\n")}

## Maintainability Review

Average component size is **${architectureMetrics.averageComponentSize} lines** with **${architectureMetrics.averageImports} imports** and **${architectureMetrics.averageChildren} JSX children** per component on average. ${
        warnings.filter((w) => w.severity === "error").length > 0
          ? "Error-level warnings indicate structural issues that should be prioritized."
          : "No error-level warnings were detected."
      }

## Performance Risks

${
  metadata.largestComponents
    .filter((c) => c.lines >= 200)
    .slice(0, 3)
    .map((c) => `- **${c.name}** (${c.lines} lines, ${c.apiCalls} API calls)`)
    .join("\n") || "- No exceptionally large components flagged beyond analysis thresholds."
}

Deep nesting depth: **${architectureMetrics.deepestComponentTree}** levels.

## Scalability Review

With ${statistics.components} components and ${Object.keys(metadata.folderStructure.subfolders).length} top-level folders, ${
        statistics.components > 50
          ? "the project may benefit from feature-based folder organization as it grows."
          : "the current scale is manageable with consistent conventions."
      }

## Refactoring Opportunities

${metadata.largestComponents
  .slice(0, 3)
  .map(
    (c) =>
      `- Split **${c.name}** (${c.lines} lines) — extract ${c.hooks.length > 0 ? `hooks (${c.hooks.join(", ")})` : "sub-components"}`
  )
  .join("\n")}

${
  unusedComponents.length > 0
    ? `- Remove or integrate unused components: ${unusedComponents.slice(0, 3).join(", ")}`
    : ""
}

## React Best Practices

| Area | Status |
|------|--------|
| Component count | ${statistics.components} |
| Hook usage | ${statistics.hooks} unique hooks |
| Route definitions | ${statistics.routes} |
| Context providers | ${statistics.contexts} |
| API layer calls | ${statistics.apiCalls} |

${
  statistics.hooks > 0
    ? "Custom hooks are in use — ensure shared logic is extracted into reusable hooks."
    : "Consider extracting reusable logic into custom hooks."
}

## Engineering Recommendations

1. Address ${warnings.length} static analysis warning(s) starting with highest severity.
2. Keep components under 300 lines — largest is **${architectureMetrics.largestComponent}**.
3. ${
        circularDependencies.length > 0
          ? "Break circular import chains by introducing shared modules or inversion."
          : "Maintain acyclic dependency boundaries between feature modules."
      }
4. Review API call distribution — ${statistics.apiCalls} calls across ${statistics.components} components.

## Final Verdict

**${metadata.projectName}** demonstrates a ${score >= 70 ? "solid" : score >= 50 ? "moderate" : "needs-improvement"} React architecture with ${statistics.components} components. ${
        warnings.length === 0
          ? "Static analysis found no major structural issues."
          : `${warnings.length} warning(s) warrant attention before scaling further.`
      } Focus on ${weaknesses[0]?.replace(/^-\s*/, "") ?? "maintaining modular boundaries"} for the highest impact improvement.`;
    }
  };
}
