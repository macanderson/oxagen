// session-skills.ts: the published skills a session reads while it runs
// (steering-repo-spec, Scope and binding).
//
// A bundle from a control plane that knows the "skills" feature carries the
// workspace's and the organization's published skills. At a session's start
// the daemon writes them where the session's harness reads user skills, and
// at its end it removes every folder no other live session holds
// (`../skills/place`).
//
// The harness's own environment picks the folder, so a session started with
// `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `STELLA_HOME` set reads the skills
// from there. Removal goes to the folder the start wrote to. The daemon's
// sweep ends a session with no hook env to read, which is how every Stella
// session ends, because Stella sends no SessionEnd. Cursor and Claude
// Desktop read no skills folder, so a session of either places nothing.
//
// A write or removal that fails is logged and never fails the hook. A
// session without its skills still runs under its permissions. A folder a
// session left behind goes at the first session end after that session's
// hold lapses (`SESSION_TTL_MS`).
//
// The daemon runs each session's hooks on that session's own queue, so two
// sessions' starts and ends run side by side. Each place and removal reads a
// folder's marker and then writes it, and two of them interleaved could
// delete a folder a live session had just joined. So they run one at a time.
// A call waits a bounded time for the one before it. Past that it is skipped
// and logged, as a failed write is, so a slow call holds no other session's
// hook for longer than that wait.
import { homedir } from "node:os";
import { decodeSkill, placeSkills, removeSkills, skillsRoot } from "../skills";
import type { BundleSkill, TachoHarness } from "../wire";

type Env = Readonly<Record<string, string | undefined>>;

/** What the hook handler asks of the host's skills folders. */
export interface SessionSkills {
  /** Write the bundle's skills for the session, where its harness reads them. */
  place(
    harness: TachoHarness,
    sessionId: string,
    skills: readonly BundleSkill[],
    env: Env,
  ): Promise<void>;
  /**
   * Take the session off every skill folder, deleting those no live session
   * holds. The folder is the one its start wrote to. When this daemon placed
   * nothing for the session, `env` picks it, and without `env` the harness's
   * default folder does.
   */
  remove(harness: TachoHarness, sessionId: string, env?: Env): Promise<void>;
}

/**
 * How long a place or removal waits for the one before it. The hook client
 * waits about five seconds for a start's answer and two and a half for a
 * Codex end, so this leaves room for the call's own writes.
 */
export const SKILLS_WAIT_MS = 1_500;

export interface SessionSkillsOptions {
  /** The home directory the harness folders live under; absent, this user's. */
  home?: string;
  now?: () => Date;
  log: (line: string) => void;
  /** How long a call waits for the one before it; absent, `SKILLS_WAIT_MS`. */
  waitMs?: number;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sessionSkills(options: SessionSkillsOptions): SessionSkills {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date());
  const waitMs = options.waitMs ?? SKILLS_WAIT_MS;
  const { log } = options;
  // The folder each live session's skills went to, so its end finds them
  // without the hook env. A daemon restart forgets it, and the TTL clears
  // what a missed removal leaves.
  const placedRoots = new Map<string, string>();
  // Settles once every call so far has finished or given up.
  let tail: Promise<void> = Promise.resolve();
  /**
   * Run `task` after every earlier call, and answer true. Answer false
   * without running it when the earlier calls take longer than `waitMs`. A
   * call that gives up still waits its turn in the chain, so a later call
   * never runs beside a slow one.
   */
  async function inTurn(task: () => Promise<void>): Promise<boolean> {
    const before = tail;
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    tail = before.then(() => mine);
    const turn = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), waitMs);
      void before.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    try {
      if (!turn) return false;
      await task();
      return true;
    } finally {
      release();
    }
  }
  return {
    async place(harness, sessionId, skills, env) {
      const root = skillsRoot(harness, env, home);
      if (root === null || skills.length === 0) return;
      placedRoots.set(sessionId, root);
      const ran = await inTurn(async () => {
        try {
          const result = await placeSkills(
            root,
            sessionId,
            skills.map(decodeSkill),
            now(),
          );
          for (const warning of result.warnings) log(`skills: ${warning}`);
        } catch (error) {
          log(
            `skills: session ${sessionId} starts without its skills, because writing them to ${root} failed: ${reason(error)}`,
          );
        }
      });
      if (!ran)
        log(
          `skills: session ${sessionId} starts without its skills, because another session's skills were still being written or removed after ${waitMs} ms.`,
        );
    },
    async remove(harness, sessionId, env) {
      const root =
        placedRoots.get(sessionId) ?? skillsRoot(harness, env ?? {}, home);
      placedRoots.delete(sessionId);
      if (root === null) return;
      const ran = await inTurn(async () => {
        try {
          await removeSkills(root, sessionId, now());
        } catch (error) {
          log(
            `skills: session ${sessionId} ended with its skills still in ${root}, because removing them failed: ${reason(error)}. A later session's end removes them once this session's hold lapses.`,
          );
        }
      });
      if (!ran)
        log(
          `skills: session ${sessionId} ended with its skills still in ${root}, because another session's skills were still being written or removed after ${waitMs} ms. A later session's end removes them once this session's hold lapses.`,
        );
    },
  };
}
