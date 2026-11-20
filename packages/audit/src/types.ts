export type ComponentMetadata = {
  name: string;
  file: string;
  lines: number;
  imports: number;
  children: number;
  hooks: string[];
  apiCalls: number;
  routes: number;
  exported: boolean;
};

export type FolderNode = {
  files: string[];
  subfolders: Record<string, FolderNode>;
  componentCount: number;
};

export type DependencyGraphMetadata = {
  nodes: Array<{ id: string; label: string; kind: string }>;
  edges: Array<{ source: string; target: string; kind: string }>;
};

export type ArchitectureMetricsMetadata = {
  averageComponentSize: number;
  largestComponent: string;
  averageImports: number;
  averageChildren: number;
  deepestComponentTree: number;
  contextCount: number;
};

export type WarningMetadata = {
  type: string;
  title: string;
  message: string;
  severity: string;
  suggestion?: string;
  filePath?: string;
};

export type ProjectAuditMetadata = {
  projectName: string;
  framework: "React";
  statistics: {
    totalFiles: number;
    components: number;
    hooks: number;
    routes: number;
    contexts: number;
    apiCalls: number;
  };
  components: ComponentMetadata[];
  largestComponents: ComponentMetadata[];
  folderStructure: FolderNode;
  dependencyGraph: DependencyGraphMetadata;
  architectureMetrics: ArchitectureMetricsMetadata;
  warnings: WarningMetadata[];
  unusedComponents: string[];
  circularDependencies: string[][];
  architectureScore: number;
};

export type AuditSection = {
  id: string;
  title: string;
  content: string;
};

export type ArchitectureAuditReport = {
  generatedAt: string;
  projectName: string;
  rawMarkdown: string;
  sections: AuditSection[];
  overallScore: number | null;
  provider: string;
};

export type AuditErrorKind = "network" | "timeout" | "invalid-response" | "empty-metadata" | "unknown";

export type AuditError = {
  kind: AuditErrorKind;
  message: string;
};

export type AiAuditProvider = {
  name: string;
  generateAudit(metadata: ProjectAuditMetadata): Promise<string>;
};
