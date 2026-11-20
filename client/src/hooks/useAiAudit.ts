import { useCallback, useEffect, useRef, useState } from "react";
import type { ArchitectureGraph } from "@rav/shared";
import { AuditServiceError, generateProjectMetadata, isMetadataEmpty } from "@rav/audit";
import type { ArchitectureAuditReport, AuditError } from "@rav/audit";
import { generateArchitectureAudit } from "../audit/aiAuditService";
import type { AuditGenerationMode } from "../audit/aiAuditService";
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
  /** "ai" while a server AI audit is in flight, "fallback" while the local rule-based summary is generated. */
  auditMode: AuditGenerationMode;
};

export function useAiAudit({ projectName, graph, enabled }: UseAiAuditOptions): UseAiAuditResult {
  const [report, setReport] = useState<ArchitectureAuditReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<AuditError | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [auditMode, setAuditMode] = useState<AuditGenerationMode>("ai");
  const requestIdRef = useRef(0);

  const runAudit = useCallback(
    async (options?: { force?: boolean }) => {
      const requestId = ++requestIdRef.current;
      setIsLoading(true);
      setError(null);
      setFromCache(false);
      setAuditMode("ai");

      const metadata = generateProjectMetadata(projectName, graph);

      if (isMetadataEmpty(metadata)) {
        setIsLoading(false);
        setError({
          kind: "empty-metadata",
          message: "No analyzable project metadata found. Load a repository with React components first."
        });
        return;
      }

      // A forced run (Re-run / Retry) skips the session cache so the user
      // actually gets a fresh report instead of the cached one.
      if (!options?.force) {
        const cached = getCachedAudit(projectName, graph.generatedAt);
        if (cached) {
          setReport(cached);
          setFromCache(true);
          setIsLoading(false);
          return;
        }
      }

      try {
        const generated = await generateArchitectureAudit(metadata, () => {
          if (requestId === requestIdRef.current) {
            setAuditMode("fallback");
          }
        });

        if (requestId !== requestIdRef.current) {
          return;
        }

        setCachedAudit(projectName, graph.generatedAt, generated.report);
        setReport(generated.report);
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
    },
    [graph, projectName]
  );

  // Retry always forces a fresh generation — otherwise it would just
  // re-display the cached report (or the same failure path).
  const retry = useCallback(() => {
    void runAudit({ force: true });
  }, [runAudit]);

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
    retry,
    fromCache,
    auditMode
  };
}
