import type { Artifact, ArtifactKind } from "@oxagen/agent-artifacts";

export type ImportPlatform = "claude" | "codex" | "cursor" | "oxagen-legacy";
export type ImportScope = "user" | "workspace";
export type ConflictDecision = "skip" | "replace" | "rename";

export interface ImportDiagnostic {
  code: string;
  message: string;
}

export interface ImportCandidate {
  platform: ImportPlatform;
  kind: ArtifactKind;
  sourcePath: string;
  /** Root copied for directory-backed skill bundles. */
  sourceBundleRoot?: string;
  sourceHash: string;
  name: string;
  description: string;
  body: string;
  model?: string;
  toolNames: string[];
  skillNames: string[];
  references: string[];
  diagnostics: ImportDiagnostic[];
}

export interface UnresolvedTool {
  sourceName: string;
  reason: "unknown_mapping" | "target_unavailable" | "ambiguous_mcp";
  suggestedTargets?: string[];
}

export interface NormalizedImport {
  candidate: ImportCandidate;
  artifact: Artifact;
  state: "ready" | "needs_review" | "rejected";
  diagnostics: ImportDiagnostic[];
  mappingVersion: string;
}

export interface ImportItemReceipt {
  sourcePath: string;
  sourceHash: string;
  destinationPath?: string;
  artifactHash?: string;
  platform: ImportPlatform;
  kind: ArtifactKind;
  name: string;
  state: NormalizedImport["state"];
  decision: ConflictDecision;
  outcome: "imported" | "skipped" | "rejected" | "unchanged";
  mappingVersion: string;
  diagnostics: ImportDiagnostic[];
}

export interface ImportReceipt {
  schemaVersion: 1;
  createdAt: string;
  scope: ImportScope;
  dryRun: boolean;
  items: ImportItemReceipt[];
}

export interface ConflictContext {
  candidate: ImportCandidate;
  destinationPath: string;
  existingKind: "file" | "directory" | "symlink";
}

export type ConflictResolver = (
  context: ConflictContext,
) => Promise<ConflictDecision> | ConflictDecision;
