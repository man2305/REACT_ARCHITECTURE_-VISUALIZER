export type SourceFile = {
  path: string;
  content: string;
};

export type GraphNodeKind =
  | "component"
  | "file"
  | "route"
  | "hook"
  | "api"
  | "provider"
  | "external";

export type GraphEdgeKind =
  | "jsx"
  | "import"
  | "route"
  | "hook"
  | "api"
  | "provider";

export type GraphNode = {
  id: string;
  label: string;
  kind: GraphNodeKind;
  filePath?: string;
  metadata?: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  label?: string;
  metadata?: Record<string, unknown>;
};

export type ApiCallInfo = {
  method: string;
  endpoint: string;
  line?: number;
};

export type RouteInfo = {
  path: string;
  component?: string;
  line?: number;
};

export type ImportInfo = {
  source: string;
  importedNames: string[];
  resolvedPath?: string;
};

export type ComponentInfo = {
  name: string;
  filePath: string;
  lineCount: number;
  imports: ImportInfo[];
  jsxChildren: string[];
  hooks: string[];
  routes: RouteInfo[];
  apiCalls: ApiCallInfo[];
  providers: string[];
  propsToChildren: Record<string, string[]>;
  exported: boolean;
};

export type ArchitectureWarning = {
  type:
    | "dead-component"
    | "circular-dependency"
    | "large-component"
    | "parse-error";
  title: string;
  message: string;
  filePath?: string;
  severity: "info" | "warning" | "error";
  metadata?: Record<string, unknown>;
};

export type ArchitectureMetrics = {
  fileCount: number;
  componentCount: number;
  importCount: number;
  routeCount: number;
  hookCount: number;
  apiCallCount: number;
  warningCount: number;
  architectureScore: number;
};

export type ArchitectureGraph = {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  components: ComponentInfo[];
  warnings: ArchitectureWarning[];
  metrics: ArchitectureMetrics;
};

export type AnalyzeFilesRequest = {
  files: SourceFile[];
};

export type AnalyzeGithubRequest = {
  repositoryUrl: string;
  ref?: string;
};

export type AnalyzeResponse = {
  graph: ArchitectureGraph;
};
