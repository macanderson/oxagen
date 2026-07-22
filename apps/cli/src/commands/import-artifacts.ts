import type {
  ConflictResolver,
  ImportPlatform,
} from "../artifact-import/index.js";
import { importArtifacts } from "../artifact-import/index.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

const PLATFORMS = ["claude", "codex", "cursor", "oxagen-legacy"] as const;
const CORE_TOOL_CATALOG = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "bash",
  "fetch_web",
  "search_web",
]);

export interface ImportArtifactsCommandOptions {
  from?: string[];
  scope?: string;
  source?: string;
  dryRun?: boolean;
  json?: boolean;
  conflict?: string;
  choice?: string[];
}

export interface ImportArtifactsCommandDependencies {
  cwd?: string;
  userHomeDir?: string;
  toolCatalog?: ReadonlySet<string>;
  mcpMappings?: Readonly<Record<string, string>>;
  resolveConflict?: ConflictResolver;
}

function isPlatform(value: string): value is ImportPlatform {
  return PLATFORMS.includes(value as ImportPlatform);
}

export async function handleImportArtifacts(
  options: ImportArtifactsCommandOptions,
  writer: CommandWriter = stdoutWriter,
  dependencies: ImportArtifactsCommandDependencies = {},
): Promise<void> {
  const from = options.from ?? [...PLATFORMS];
  const invalid = from.filter((value) => !isPlatform(value));
  if (invalid.length > 0) {
    process.exitCode = 2;
    writer.writeErr(
      `invalid_import_platform: ${invalid.join(", ")} (use ${PLATFORMS.join(", ")})`,
    );
    return;
  }
  if (options.source && from.length !== 1) {
    process.exitCode = 2;
    writer.writeErr(
      "ambiguous_import_source: --source requires exactly one --from platform",
    );
    return;
  }
  const scope = options.scope ?? "workspace";
  if (scope !== "workspace" && scope !== "user") {
    process.exitCode = 2;
    writer.writeErr("invalid_import_scope: use workspace or user");
    return;
  }
  const conflict = options.conflict ?? "skip";
  if (conflict !== "skip" && conflict !== "replace" && conflict !== "rename") {
    process.exitCode = 2;
    writer.writeErr("invalid_import_conflict: use skip, replace, or rename");
    return;
  }

  const choices = new Map<string, "skip" | "replace" | "rename">();
  for (const entry of options.choice ?? []) {
    const [name, decision] = entry.split("=");
    if (
      !name ||
      (decision !== "skip" && decision !== "replace" && decision !== "rename")
    ) {
      process.exitCode = 2;
      writer.writeErr(
        `invalid_import_choice: ${entry} (use <artifact>=skip|replace|rename)`,
      );
      return;
    }
    choices.set(name, decision);
  }
  const choiceResolver: ConflictResolver | undefined =
    dependencies.resolveConflict ??
    (choices.size > 0
      ? (context) => choices.get(context.candidate.name) ?? "skip"
      : undefined);

  const receipt = await importArtifacts({
    cwd: dependencies.cwd,
    userHomeDir: dependencies.userHomeDir,
    scope,
    from: from as ImportPlatform[],
    sourceDir: options.source,
    dryRun: options.dryRun,
    conflict,
    resolveConflict: choiceResolver,
    toolCatalog: dependencies.toolCatalog ?? CORE_TOOL_CATALOG,
    mcpMappings: dependencies.mcpMappings,
  });
  if (options.json) {
    writer.write(JSON.stringify(receipt));
    return;
  }
  if (receipt.items.length === 0) {
    writer.write("No importable artifacts found.");
    return;
  }
  const lines = [
    `${options.dryRun ? "Would process" : "Processed"} ${receipt.items.length} artifact(s):`,
  ];
  for (const item of receipt.items) {
    const marker =
      item.outcome === "imported"
        ? "✓"
        : item.outcome === "unchanged"
          ? "="
          : item.outcome === "skipped"
            ? "–"
            : "!";
    lines.push(
      `${marker} ${item.platform} ${item.kind} ${item.name}: ${item.outcome}${item.state === "needs_review" ? " (needs review; non-executable)" : ""}`,
    );
  }
  const skipped = receipt.items.filter((item) => item.outcome === "skipped");
  if (skipped.length > 0) {
    lines.push("", "Choose each conflict in the REPL, then rerun:");
    for (const item of skipped) {
      lines.push(
        `  /import --choice ${item.name}=replace   # or skip | rename`,
      );
    }
  }
  writer.write(lines.join("\n"));
}
