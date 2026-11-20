import { buildAuditUserPrompt } from "@rav/audit";
import type { FolderNode, ProjectAuditMetadata } from "@rav/audit";

/**
 * Prompt budget for the AI audit. The full dependency graph of a large repo
 * would otherwise produce a prompt of tens of thousands of tokens, so the
 * metadata is trimmed (graph first, then components/warnings, then folder
 * file lists) until the rendered prompt fits. ~60k chars ≈ 15k tokens.
 */
export const MAX_PROMPT_CHARS = 60_000;
const MAX_NODES = 120;
const MAX_EDGES = 250;
const MIN_NODES = 20;
const MIN_EDGES = 40;
const MIN_COMPONENTS = 10;
const MIN_WARNINGS = 10;
const MAX_LARGEST_COMPONENTS = 10;
const MAX_UNUSED_COMPONENTS = 50;
const MAX_CIRCULAR_DEPENDENCIES = 20;

export function trimAuditMetadata(metadata: ProjectAuditMetadata): ProjectAuditMetadata {
  let nodeLimit = Math.min(metadata.dependencyGraph.nodes.length, MAX_NODES);
  let edgeLimit = Math.min(metadata.dependencyGraph.edges.length, MAX_EDGES);
  let componentLimit = metadata.components.length;
  let warningLimit = metadata.warnings.length;
  let foldersStripped = false;

  const build = (): ProjectAuditMetadata => ({
    ...metadata,
    components: metadata.components.slice(0, componentLimit),
    // These lists are already top-N by construction, but cap them so a
    // hostile client cannot smuggle an unbounded payload past the budget.
    largestComponents: metadata.largestComponents.slice(0, MAX_LARGEST_COMPONENTS),
    unusedComponents: metadata.unusedComponents.slice(0, MAX_UNUSED_COMPONENTS),
    circularDependencies: metadata.circularDependencies.slice(0, MAX_CIRCULAR_DEPENDENCIES),
    dependencyGraph: {
      nodes: metadata.dependencyGraph.nodes.slice(0, nodeLimit),
      edges: metadata.dependencyGraph.edges.slice(0, edgeLimit)
    },
    warnings: metadata.warnings.slice(0, warningLimit),
    folderStructure: foldersStripped
      ? stripFolderFiles(metadata.folderStructure)
      : metadata.folderStructure
  });

  let trimmed = build();
  while (buildAuditUserPrompt(trimmed).length > MAX_PROMPT_CHARS) {
    if (nodeLimit > MIN_NODES) {
      nodeLimit = Math.max(MIN_NODES, Math.floor(nodeLimit / 2));
    } else if (edgeLimit > MIN_EDGES) {
      edgeLimit = Math.max(MIN_EDGES, Math.floor(edgeLimit / 2));
    } else if (componentLimit > MIN_COMPONENTS) {
      componentLimit = Math.max(MIN_COMPONENTS, Math.floor(componentLimit / 2));
    } else if (warningLimit > MIN_WARNINGS) {
      warningLimit = Math.max(MIN_WARNINGS, Math.floor(warningLimit / 2));
    } else if (!foldersStripped) {
      foldersStripped = true;
    } else {
      // At the floor on every dimension; send what remains.
      break;
    }
    trimmed = build();
  }
  return trimmed;
}

/** Keep the folder skeleton (subfolders + component counts) but drop file lists. */
function stripFolderFiles(node: FolderNode): FolderNode {
  const subfolders: Record<string, FolderNode> = {};
  for (const [name, child] of Object.entries(node.subfolders)) {
    subfolders[name] = stripFolderFiles(child);
  }
  return { files: [], subfolders, componentCount: node.componentCount };
}
