import { useCallback, useEffect, useRef, useState } from "react";
import type { ArchitectureGraph } from "@rav/shared";
import {
  AuditServiceError,
  generateProjectMetadata,
  isMetadataEmpty,
  isValidAuditResponse,
  parseAuditMarkdown
} from "@rav/audit";
import type { ArchitectureAuditReport, AuditError } from "@rav/audit";
import { generateArchitectureAudit, getAuditProvider } from "../audit/aiAuditService";
import { getCachedAudit, setCachedAudit } from "../audit/aiAuditCache";

type UseAiAuditOptions = {
  projectName: string;
  graph: ArchitectureGraph;
  enabled: boolean;
};

type UseAiAuditResult = {
  report: ArchitectureAuditReport | null;
  isLoading: boolean;
  error: AuditError | null;
  retry: () => void;
  fromCache: boolean;
};

export function useAiAudit({ projectName, graph, enabled }: UseAiAuditOptions): UseAiAuditResult {
  const [report, setReport] = useState<ArchitectureAuditReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<AuditError | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const requestIdRef = useRef(0);

  const runAudit = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    setFromCache(false);

    const metadata = generateProjectMetadata(projectName, graph);

    if (isMetadataEmpty(metadata)) {
      setIsLoading(false);
      setError({
        kind: "empty-metadata",
        message: "No analyzable project metadata found. Load a repository with React components first."
      });
      return;
    }

    const cached = getCachedAudit(projectName, graph.generatedAt);
    if (cached) {
      setReport(cached);
      setFromCache(true);
      setIsLoading(false);
      return;
    }

    try {
      const provider = getAuditProvider();
      const markdown = await generateArchitectureAudit(metadata);

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!isValidAuditResponse(markdown)) {
        setError({
          kind: "invalid-response",
          message: "The AI returned an incomplete audit report. Please try again."
        });
        setIsLoading(false);
        return;
      }

      const parsed = parseAuditMarkdown(markdown, projectName, provider.name);
      setCachedAudit(projectName, graph.generatedAt, parsed);
      setReport(parsed);
    } catch (auditError: unknown) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (auditError instanceof AuditServiceError) {
        const kindMap = {
          network: "network" as const,
          timeout: "timeout" as const,
          "invalid-response": "invalid-response" as const,
          configuration: "network" as const
        };
        setError({
          kind: kindMap[auditError.kind],
          message: auditError.message
        });
      } else {
        setError({
          kind: "unknown",
          message: auditError instanceof Error ? auditError.message : "An unexpected error occurred."
        });
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [graph, projectName]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void runAudit();
  }, [enabled, runAudit]);

  return {
    report,
    isLoading,
    error,
    retry: runAudit,
    fromCache
  };
}
