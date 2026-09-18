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
import { dirname, join } from "node:path";

/** The substring that identifies an entry as this feature's. */
export const HOOK_MARKER = "oxagen steering gate";

/** Harnesses this can install into. */
export const INSTALLABLE = ["claude-code", "codex"] as const;
export type InstallableHarness = (typeof INSTALLABLE)[number];

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

/** Where each harness keeps its project-scoped hook config. */
export function hookConfigPath(
  projectRoot: string,
  harness: InstallableHarness,
): string {
  return harness === "claude-code"
    ? join(projectRoot, ".claude", "settings.json")
    : join(projectRoot, ".codex", "hooks.json");
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

function readConfig(text: string): HookConfig | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
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
