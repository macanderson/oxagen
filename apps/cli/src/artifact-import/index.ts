import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverImportCandidates } from "./discover";
import { normalizeImportCandidate } from "./normalize";
import type {
  ConflictDecision,
  ConflictResolver,
  ImportPlatform,
  ImportReceipt,
  ImportScope,
} from "./types";
import { activateImportedArtifact } from "./write";

export { discoverImportCandidates } from "./discover";
export { normalizeImportCandidate, normalizeArtifactSlug } from "./normalize";
export { activateImportedArtifact } from "./write";
export * from "./types";

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
