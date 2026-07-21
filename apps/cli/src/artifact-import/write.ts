import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
  if (path.endsWith("/skill.toml")) {
    const bundle = dirname(path);
    const parent = dirname(bundle);
    const name = bundle.slice(parent.length + 1);
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = join(parent, `${name}-imported-${index}`, "skill.toml");
      if ((await pathKind(dirname(candidate))) === null) return candidate;
    }
    throw new Error(
      "artifact_conflict_exhausted: could not allocate a renamed skill bundle",
    );
  }
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

async function copySkillSidecars(
  sourceRoot: string,
  sourceManifest: string,
  destinationRoot: string,
): Promise<void> {
  async function walk(
    sourceDir: string,
    destinationDir: string,
  ): Promise<void> {
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = join(sourceDir, entry.name);
      const destination = join(destinationDir, entry.name);
      if (
        source === sourceManifest ||
        (sourceDir === sourceRoot &&
          ["SKILL.md", "skill.md", "skill.toml"].includes(entry.name))
      )
        continue;
      if (entry.isDirectory()) {
        await mkdir(destination, { recursive: true });
        await walk(source, destination);
      } else if (entry.isFile()) {
        await copyFile(source, destination);
      }
      // Foreign symlinks are intentionally not carried into Oxagen-owned bundles.
    }
  }
  await walk(sourceRoot, destinationRoot);
}

async function activateSkillBundle(
  normalized: NormalizedImport,
  destinationPath: string,
  content: string,
): Promise<void> {
  const destinationRoot = dirname(destinationPath);
  const parent = dirname(destinationRoot);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(join(parent, ".oxagen-import-"));
  let backupRoot: string | undefined;
  try {
    const sourceRoot = normalized.candidate.sourceBundleRoot;
    if (sourceRoot) {
      await copySkillSidecars(
        sourceRoot,
        normalized.candidate.sourcePath,
        stagingRoot,
      );
    }
    await writeFile(join(stagingRoot, "skill.toml"), content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    if ((await pathKind(destinationRoot)) !== null) {
      backupRoot = await mkdtemp(join(parent, ".oxagen-backup-"));
      await rm(backupRoot, { recursive: true });
      await rename(destinationRoot, backupRoot);
    }
    try {
      await rename(stagingRoot, destinationRoot);
    } catch (error) {
      if (backupRoot) await rename(backupRoot, destinationRoot);
      throw error;
    }
    if (backupRoot) await rm(backupRoot, { recursive: true });
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
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
  const existing =
    normalized.artifact.kind === "skill"
      ? ((await pathKind(destinationPath)) ??
        (await pathKind(dirname(destinationPath))))
      : await pathKind(destinationPath);
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

  if (normalized.artifact.kind === "skill") {
    await activateSkillBundle(normalized, destinationPath, content);
    return { destinationPath, decision, outcome: "imported", artifactHash };
  }

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
