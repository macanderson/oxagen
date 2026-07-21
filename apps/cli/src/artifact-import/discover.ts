import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ImportCandidate, ImportPlatform, ImportScope } from "./types";

interface SourceSpec {
  platform: ImportPlatform;
  kind: ImportCandidate["kind"];
  dir: string;
  layout: "flat" | "bundle";
}

function scalarList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  const normalized = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return normalized
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return null;
  try {
    const parsed: unknown = parseYaml(normalized.slice(4, end));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    return {
      data: parsed as Record<string, unknown>,
      body: normalized.slice(end + 5).trim(),
    };
  } catch {
    return null;
  }
}

async function sourceFiles(spec: SourceSpec): Promise<string[]> {
  try {
    const entries = await readdir(spec.dir, { withFileTypes: true });
    if (spec.layout === "flat") {
      return entries
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .filter(
          (entry) => entry.name.endsWith(".md") || entry.name.endsWith(".mdc"),
        )
        .map((entry) => join(spec.dir, entry.name))
        .sort();
    }
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .flatMap((entry) => [
        join(spec.dir, entry.name, "SKILL.md"),
        join(spec.dir, entry.name, "skill.md"),
      ])
      .sort();
  } catch {
    return [];
  }
}

function workspaceSpecs(cwd: string): SourceSpec[] {
  return [
    {
      platform: "claude",
      kind: "agent",
      dir: join(cwd, ".claude", "agents"),
      layout: "flat",
    },
    {
      platform: "claude",
      kind: "skill",
      dir: join(cwd, ".claude", "skills"),
      layout: "bundle",
    },
    {
      platform: "claude",
      kind: "command",
      dir: join(cwd, ".claude", "commands"),
      layout: "flat",
    },
    {
      platform: "codex",
      kind: "agent",
      dir: join(cwd, ".codex", "agents"),
      layout: "flat",
    },
    {
      platform: "codex",
      kind: "skill",
      dir: join(cwd, ".codex", "skills"),
      layout: "bundle",
    },
    {
      platform: "codex",
      kind: "command",
      dir: join(cwd, ".codex", "commands"),
      layout: "flat",
    },
    {
      platform: "codex",
      kind: "agent",
      dir: join(cwd, ".agents", "agents"),
      layout: "flat",
    },
    {
      platform: "codex",
      kind: "skill",
      dir: join(cwd, ".agents", "skills"),
      layout: "bundle",
    },
    {
      platform: "codex",
      kind: "command",
      dir: join(cwd, ".agents", "commands"),
      layout: "flat",
    },
    {
      platform: "cursor",
      kind: "agent",
      dir: join(cwd, ".cursor", "agents"),
      layout: "flat",
    },
    {
      platform: "cursor",
      kind: "skill",
      dir: join(cwd, ".cursor", "skills"),
      layout: "bundle",
    },
    {
      platform: "cursor",
      kind: "command",
      dir: join(cwd, ".cursor", "commands"),
      layout: "flat",
    },
    {
      platform: "oxagen-legacy",
      kind: "agent",
      dir: join(cwd, ".oxagen", "agents"),
      layout: "flat",
    },
    {
      platform: "oxagen-legacy",
      kind: "skill",
      dir: join(cwd, ".oxagen", "skills"),
      layout: "bundle",
    },
    {
      platform: "oxagen-legacy",
      kind: "command",
      dir: join(cwd, ".oxagen", "commands"),
      layout: "flat",
    },
  ];
}

function userSpecs(home: string): SourceSpec[] {
  return workspaceSpecs(home).map((spec) => {
    if (spec.platform === "oxagen-legacy") {
      return {
        ...spec,
        dir: spec.dir.replace(
          join(home, ".oxagen"),
          join(home, ".config", "oxagen"),
        ),
      };
    }
    return spec;
  });
}

export async function discoverImportCandidates(options: {
  cwd?: string;
  scope: ImportScope;
  userHomeDir?: string;
  from?: readonly ImportPlatform[];
  sourceDir?: string;
}): Promise<ImportCandidate[]> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.userHomeDir ?? homedir();
  let specs =
    options.scope === "workspace" ? workspaceSpecs(cwd) : userSpecs(home);
  if (options.from)
    specs = specs.filter((spec) => options.from?.includes(spec.platform));
  if (options.sourceDir) {
    specs = specs.map((spec) => ({
      ...spec,
      dir: options.sourceDir as string,
    }));
  }

  const candidates: ImportCandidate[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    for (const sourcePath of await sourceFiles(spec)) {
      try {
        const [actualPath, raw] = await Promise.all([
          realpath(sourcePath),
          readFile(sourcePath, "utf8"),
        ]);
        const parsed = parseFrontmatter(raw);
        if (!parsed || !parsed.body) continue;
        const sourceHash = createHash("sha256")
          .update(raw, "utf8")
          .digest("hex");
        const dedupeKey = `${actualPath}:${sourceHash}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const fallbackName =
          spec.kind === "skill"
            ? basename(join(sourcePath, ".."))
            : basename(sourcePath).replace(/\.(md|mdc)$/, "");
        const name =
          typeof parsed.data.name === "string"
            ? parsed.data.name
            : fallbackName;
        const description =
          typeof parsed.data.description === "string"
            ? parsed.data.description
            : "Imported artifact";
        candidates.push({
          platform: spec.platform,
          kind: spec.kind,
          sourcePath,
          sourceHash,
          name,
          description,
          body: parsed.body,
          model:
            typeof parsed.data.model === "string"
              ? parsed.data.model
              : undefined,
          toolNames: scalarList(
            parsed.data.tools ??
              parsed.data["allowed-tools"] ??
              parsed.data.allowed_tools,
          ),
          skillNames: scalarList(parsed.data.skills),
          references: scalarList(parsed.data.references),
          diagnostics: [],
        });
      } catch {
        // An untrusted broken item is isolated; valid siblings remain discoverable.
      }
    }
  }
  return candidates.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}
