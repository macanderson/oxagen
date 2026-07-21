import { lstat, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  hashArtifact,
  parseArtifactToml,
  serializeArtifactToml,
} from "@oxagen/agent-artifacts";
import type {
  ConflictDecision,
  ConflictResolver,
  ImportScope,
  NormalizedImport,
} from "./types";

async function pathKind(
  path: string,
): Promise<"file" | "directory" | "symlink" | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    return "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function initialDestination(
  root: string,
  normalized: NormalizedImport,
): string {
  const name = normalized.artifact.name;
  if (normalized.artifact.kind === "skill")
    return join(root, "skills", name, "skill.toml");
  return join(root, `${normalized.artifact.kind}s`, `${name}.toml`);
}

async function renamedDestination(path: string): Promise<string> {
  const extension = ".toml";
  const stem = path.slice(0, -extension.length);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem}-imported-${index}${extension}`;
    if ((await pathKind(candidate)) === null) return candidate;
  }
  throw new Error(
    "artifact_conflict_exhausted: could not allocate a renamed destination",
  );
}

export async function activateImportedArtifact(
  normalized: NormalizedImport,
  options: {
    cwd?: string;
    userHomeDir?: string;
    scope: ImportScope;
    dryRun?: boolean;
    conflict?: ConflictDecision;
    resolveConflict?: ConflictResolver;
  },
): Promise<{
  destinationPath: string;
  decision: ConflictDecision;
  outcome: "imported" | "skipped";
  artifactHash: string;
}> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.userHomeDir ?? homedir();
  const root =
    options.scope === "workspace"
      ? join(cwd, ".oxagen")
      : join(home, ".config", "oxagen");
  let destinationPath = initialDestination(root, normalized);
  const existing = await pathKind(destinationPath);
  let decision: ConflictDecision = options.conflict ?? "skip";
  if (existing && options.resolveConflict) {
    decision = await options.resolveConflict({
      candidate: normalized.candidate,
      destinationPath,
      existingKind: existing,
    });
  }
  if (existing && decision === "skip") {
    return {
      destinationPath,
      decision,
      outcome: "skipped",
      artifactHash: hashArtifact(normalized.artifact),
    };
  }
  if (existing && decision === "rename")
    destinationPath = await renamedDestination(destinationPath);

  const content = serializeArtifactToml(normalized.artifact);
  parseArtifactToml(content);
  const artifactHash = hashArtifact(normalized.artifact);
  if (options.dryRun)
    return { destinationPath, decision, outcome: "imported", artifactHash };

  await mkdir(dirname(destinationPath), { recursive: true });
  const stagingDir = await mkdtemp(
    join(dirname(destinationPath), ".oxagen-import-"),
  );
  const staged = join(stagingDir, "artifact.toml");
  await writeFile(staged, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(staged, destinationPath);
  return { destinationPath, decision, outcome: "imported", artifactHash };
}
