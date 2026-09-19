/**
 * hooks.ts — installing the gate into whichever agent the team already runs.
 *
 * ## Why an installer exists at all
 *
 * The gate is only worth building if it is actually in front of a prompt,
 * and the step people skip is the one where they hand-edit a JSON file they
 * have never opened. So `oxagen steering hooks install` writes it, and
 * writing it is the part that has to be careful: these are files the
 * developer owns and that hold other people's hooks.
 *
 * Three rules hold for every harness below.
 *
 * 1. **Never clobber.** The file is read, the Oxagen entry is replaced by
 *    marker match, and everything else is written back untouched. A config
 *    that cannot be parsed is left alone and reported, because a
 *    half-understood rewrite of someone's hook config is worse than not
 *    installing.
 * 2. **Idempotent.** Installing twice leaves one entry. The marker is the
 *    command string, not a position, so a developer who reorders their hooks
 *    keeps their order.
 * 3. **Uninstallable.** Anything this writes, `remove` takes back out,
 *    including the file itself when nothing else is left in it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The substring that identifies an entry as this feature's. */
export const HOOK_MARKER = "oxagen steering gate";

/** Harnesses this can install into. */
export const INSTALLABLE = ["claude-code", "codex"] as const;
export type InstallableHarness = (typeof INSTALLABLE)[number];

/**
 * Wrapped harnesses this installer has no config writer for.
 *
 * Oxagen wraps four agents with a pre-prompt hook (`WRAPPED_HARNESSES` in
 * `@oxagen/tacho`), and two of them are here: Cursor and Stella. The gate
 * itself runs for either one, because `oxagen steering gate --harness <name>`
 * falls back to the text renderer and the exit-code contract for a name it
 * does not know. What is missing is the part that puts the command in front
 * of a prompt: neither has a hook-config path this code can write, so nothing
 * calls the gate until someone wires it by hand.
 *
 * The list is written out rather than imported, because this package depends
 * on git and `zod` and nothing else. Re-registering one of these names is a
 * config writer in `hookConfigPath` and a move from this list to
 * {@link INSTALLABLE}.
 *
 * It exists so `--harness all` can say what it did. Installing "all" and
 * getting two of four, with no word about the other two, is how a team ends
 * up believing their Cursor prompts are gated when nothing is checking them.
 */
export const UNINSTALLABLE = ["cursor", "stella"] as const;
export type UninstallableHarness = (typeof UNINSTALLABLE)[number];

/**
 * What `--harness all` did not cover, in one line for a person to read.
 *
 * Printed by `oxagen steering hooks install` and `status`, so the honest
 * scope of "all" is in the output rather than only in the source.
 */
export function ungatedHarnessNotice(): string {
  return `No hook was installed for ${UNINSTALLABLE.join(
    " or ",
  )}: Oxagen has no config writer for either yet, so prompts there are not gated. Call \`oxagen steering gate --harness <name>\` from that harness's own pre-prompt hook and treat exit 2 as a refusal, with the reason on stderr.`;
}

export interface HookIo {
  read: typeof readFile;
  write: typeof writeFile;
  mkdirp: (path: string) => Promise<unknown>;
}

const defaultIo: HookIo = {
  read: readFile,
  write: writeFile,
  mkdirp: (path) => mkdir(path, { recursive: true }),
};

export interface InstallResult {
  harness: InstallableHarness;
  path: string;
  /** "installed" on a first write, "updated" when an entry was replaced. */
  outcome: "installed" | "updated" | "removed" | "absent" | "refused";
  message: string;
}

/** The command a hook runs. `--harness` picks the renderer at run time. */
export function hookCommand(harness: InstallableHarness): string {
  return `oxagen steering gate --harness ${harness}`;
}

/**
 * Where each harness reads its hook config.
 *
 * The two are NOT symmetric, and writing them as if they were left the Codex
 * installer reporting success over a file Codex never opens — the gate
 * inactive for every prompt, on a harness the command advertises.
 *
 *   - Claude Code reads `<project>/.claude/settings.json`, a project-scoped
 *     file, so the hook lands beside the repository it governs.
 *   - Codex has no project-scoped hook file. It reads `$CODEX_HOME/hooks.json`
 *     (`~/.codex/hooks.json` by default) and nothing else — the same path
 *     `packages/tacho/src/host/paths.ts` resolves for its own Codex writer,
 *     verified there against developers.openai.com/codex/hooks.
 *
 * `env` and `home` are parameters so a test can pin both without touching the
 * developer's real home directory.
 */
export function hookConfigPath(
  projectRoot: string,
  harness: InstallableHarness,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (harness === "claude-code")
    return join(projectRoot, ".claude", "settings.json");
  return join(env["CODEX_HOME"] ?? join(home, ".codex"), "hooks.json");
}

interface HookCommandEntry {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

interface HookGroup {
  hooks?: HookCommandEntry[];
  [k: string]: unknown;
}

interface HookConfig {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/**
 * The hook's own timeout, in seconds.
 *
 * It has to be longer than the git fetch it may perform and shorter than a
 * developer's patience. A hook that times out is treated by both harnesses
 * as a failure, which does not block the prompt, so the cost of being wrong
 * here is a missed warning rather than a wedged agent.
 */
export const HOOK_TIMEOUT_SECONDS = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse a hook config, or return null for one this code cannot edit safely.
 *
 * Valid JSON is not enough. A file whose `hooks` is a string, or whose
 * `hooks.UserPromptSubmit` is an object rather than an array, was accepted
 * by the cast and then hit array methods in the install, remove, and status
 * paths, which threw instead of refusing and leaving the file alone. Every
 * level the writers touch is checked here: `hooks` is an object, each event
 * is an array of objects, and each group's `hooks` (when present) is an
 * array of objects.
 */
function readConfig(text: string): HookConfig | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed["hooks"] === undefined) return parsed as HookConfig;
    const hooks = parsed["hooks"];
    if (!isRecord(hooks)) return null;
    for (const groups of Object.values(hooks)) {
      if (!Array.isArray(groups)) return null;
      for (const group of groups) {
        if (!isRecord(group)) return null;
        if (group["hooks"] === undefined) continue;
        if (!Array.isArray(group["hooks"])) return null;
        if (!group["hooks"].every(isRecord)) return null;
      }
    }
    return parsed as HookConfig;
  } catch {
    return null;
  }
}

/** Strip every group whose command carries the marker. Returns what is left. */
function withoutOxagen(groups: HookGroup[]): HookGroup[] {
  const kept: HookGroup[] = [];
  for (const group of groups) {
    const hooks = (group.hooks ?? []).filter(
      (h) => !String(h.command ?? "").includes(HOOK_MARKER),
    );
    // A group that held nothing but the Oxagen entry goes with it, rather
    // than being left behind as an empty object the next reader has to
    // wonder about.
    if (hooks.length === 0 && (group.hooks ?? []).length > 0) continue;
    kept.push(
      hooks.length === (group.hooks ?? []).length ? group : { ...group, hooks },
    );
  }
  return kept;
}

async function loadConfig(
  path: string,
  io: HookIo,
): Promise<{ config: HookConfig; existed: boolean } | "unparseable"> {
  let text: string;
  try {
    text = String(await io.read(path, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { config: {}, existed: false };
    }
    return "unparseable";
  }
  if (text.trim() === "") return { config: {}, existed: true };
  const config = readConfig(text);
  return config === null ? "unparseable" : { config, existed: true };
}

/** Add, or refresh, the `UserPromptSubmit` entry for one harness. */
export async function installHook(
  projectRoot: string,
  harness: InstallableHarness,
  io: HookIo = defaultIo,
): Promise<InstallResult> {
  const path = hookConfigPath(projectRoot, harness);
  const loaded = await loadConfig(path, io);
  if (loaded === "unparseable") {
    return {
      harness,
      path,
      outcome: "refused",
      message: `${path} could not be read as JSON, so it was left alone. Fix it, then run this again.`,
    };
  }

  const { config } = loaded;
  const hooks = { ...(config.hooks ?? {}) };
  const existing = hooks.UserPromptSubmit ?? [];
  const had = existing.some((g) =>
    (g.hooks ?? []).some((h) => String(h.command ?? "").includes(HOOK_MARKER)),
  );
  hooks.UserPromptSubmit = [
    ...withoutOxagen(existing),
    {
      hooks: [
        {
          type: "command",
          command: hookCommand(harness),
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    },
  ];

  await io.mkdirp(dirname(path));
  await io.write(
    path,
    `${JSON.stringify({ ...config, hooks }, null, 2)}\n`,
    "utf8",
  );
  return {
    harness,
    path,
    outcome: had ? "updated" : "installed",
    message: `${had ? "Updated" : "Installed"} the steering gate in ${path}.`,
  };
}

/** Take the entry back out, and the file with it when nothing else is left. */
export async function removeHook(
  projectRoot: string,
  harness: InstallableHarness,
  io: HookIo = defaultIo,
): Promise<InstallResult> {
  const path = hookConfigPath(projectRoot, harness);
  const loaded = await loadConfig(path, io);
  if (loaded === "unparseable") {
    return {
      harness,
      path,
      outcome: "refused",
      message: `${path} could not be read as JSON, so it was left alone.`,
    };
  }
  if (!loaded.existed) {
    return {
      harness,
      path,
      outcome: "absent",
      message: `No ${harness} hook config at ${path}.`,
    };
  }

  const { config } = loaded;
  const hooks = { ...(config.hooks ?? {}) };
  const existing = hooks.UserPromptSubmit ?? [];
  const kept = withoutOxagen(existing);
  if (kept.length === existing.length) {
    return {
      harness,
      path,
      outcome: "absent",
      message: `The steering gate is not installed in ${path}.`,
    };
  }
  if (kept.length === 0) delete hooks.UserPromptSubmit;
  else hooks.UserPromptSubmit = kept;

  const next: HookConfig = { ...config };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;

  await io.write(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    harness,
    path,
    outcome: "removed",
    message: `Removed the steering gate from ${path}.`,
  };
}

/** Is the gate installed for this harness right now? */
export async function hookStatus(
  projectRoot: string,
  harness: InstallableHarness,
  io: HookIo = defaultIo,
): Promise<{ harness: InstallableHarness; path: string; installed: boolean }> {
  const path = hookConfigPath(projectRoot, harness);
  const loaded = await loadConfig(path, io);
  if (loaded === "unparseable") return { harness, path, installed: false };
  const installed = (loaded.config.hooks?.UserPromptSubmit ?? []).some((g) =>
    (g.hooks ?? []).some((h) => String(h.command ?? "").includes(HOOK_MARKER)),
  );
  return { harness, path, installed };
}
