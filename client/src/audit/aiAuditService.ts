import { createMetadataProvider, createOpenAiProvider } from "@rav/audit";
import type { AiAuditProvider, ProjectAuditMetadata } from "@rav/audit";

let activeProvider: AiAuditProvider | null = null;

export function getAuditProvider(): AiAuditProvider {
  if (activeProvider) {
    return activeProvider;
  }

  const apiKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
  activeProvider = apiKey
    ? createOpenAiProvider({
        apiKey,
        apiUrl:
          (import.meta.env.VITE_OPENAI_API_URL as string | undefined) ??
          "https://api.openai.com/v1/chat/completions",
        model: (import.meta.env.VITE_OPENAI_MODEL as string | undefined) ?? "gpt-4o-mini"
      })
    : createMetadataProvider();
  return activeProvider;
}

export function setAuditProvider(provider: AiAuditProvider): void {
  activeProvider = provider;
}

export async function generateArchitectureAudit(metadata: ProjectAuditMetadata): Promise<string> {
  const provider = getAuditProvider();
  return provider.generateAudit(metadata);
}
