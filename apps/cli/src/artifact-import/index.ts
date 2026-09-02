import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverImportCandidates } from "./discover.js";
import {
  normalizeArtifactSlug,
  normalizeImportCandidate,
} from "./normalize.js";
import { TOOL_MAPPING_VERSION } from "./tool-mappings.js";
import type {
  ConflictDecision,
  ConflictResolver,
  ImportPlatform,
  ImportReceipt,
  ImportScope,
} from "./types.js";
import { activateImportedArtifact } from "./write.js";

export { discoverImportCandidates } from "./discover.js";
export {
  normalizeImportCandidate,
  normalizeArtifactSlug,
} from "./normalize.js";
export { activateImportedArtifact } from "./write.js";
export * from "./types.js";

export async function importArtifacts(options: {
  cwd?: string;
  userHomeDir?: string;
  scope: ImportScope;
  from?: readonly ImportPlatform[];
  sourceDir?: string;
  dryRun?: boolean;
  conflict?: ConflictDecision;
  resolveConflict?: ConflictResolver;
  toolCatalog: ReadonlySet<string>;
  mcpMappings?: Readonly<Record<string, string>>;
  writeReceipt?: boolean;
}): Promise<ImportReceipt> {
  const candidates = await discoverImportCandidates(options);
  const receipt: ImportReceipt = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    scope: options.scope,
    dryRun: options.dryRun ?? false,
    items: [],
  };
  for (const candidate of candidates) {
    // Sources are untrusted. A candidate that fails normalization, validation,
    // containment, or activation is recorded as `rejected` and the run
    // continues — one hostile or corrupt item must never hide its valid
    // siblings, and the failure must leave a receipt rather than vanishing.
    try {
      const normalized = normalizeImportCandidate(candidate, options);
      const result = await activateImportedArtifact(normalized, options);
      receipt.items.push({
        sourcePath: candidate.sourcePath.replace(homedir(), "~"),
        sourceHash: candidate.sourceHash,
        destinationPath: result.destinationPath.replace(homedir(), "~"),
        artifactHash: result.artifactHash,
        platform: candidate.platform,
        kind: candidate.kind,
        name: normalized.artifact.name,
        state: normalized.state,
        decision: result.decision,
        outcome: result.outcome,
        mappingVersion: normalized.mappingVersion,
        diagnostics: normalized.diagnostics,
      });
    } catch (error) {
      receipt.items.push({
        sourcePath: candidate.sourcePath.replace(homedir(), "~"),
        sourceHash: candidate.sourceHash,
        platform: candidate.platform,
        kind: candidate.kind,
        name: normalizeArtifactSlug(candidate.name),
        state: "rejected",
        decision: options.conflict ?? "skip",
        outcome: "rejected",
        mappingVersion: TOOL_MAPPING_VERSION,
        diagnostics: [
          ...candidate.diagnostics,
          {
            code: "artifact_rejected",
            message:
              error instanceof Error ? error.message : "unknown import failure",
          },
        ],
      });
    }
  }

  if (
    options.writeReceipt !== false &&
    !options.dryRun &&
    receipt.items.length > 0
  ) {
    const cwd = options.cwd ?? process.cwd();
    const home = options.userHomeDir ?? homedir();
    const root =
      options.scope === "workspace"
        ? join(cwd, ".oxagen")
        : join(home, ".config", "oxagen");
    const dir = join(root, "import-receipts");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${receipt.createdAt.replaceAll(":", "-")}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }
  return receipt;
}
