/**
 * dispatch.ts — fire-and-forget session dispatch into a detached worker
 * (ADR-023 §4: "dispatch is immediate, always").
 *
 * The ONE code path behind every surface that starts a session whose owner is
 * a separate process: `oxagen fleet dispatch`, the REPL's trailing-`&` prompt,
 * and scripts. It creates the session directory (owner "worker", pid 0 —
 * the worker stamps its real pid when it boots) and re-execs THIS CLI as
 * `fleet worker <sid>`, detached and unref'd, so the dispatching process can
 * exit immediately — the session's lifetime belongs to the store, not to the
 * terminal that started it.
 *
 * Re-exec uses `process.execPath` + `process.execArgv` + `process.argv[1]` so
 * the worker inherits the same module loader in both distributions: the
 * bundled `dist/index.js` (empty execArgv) and `tsx src/index.tsx` dev runs
 * (execArgv carries tsx's --import hook). `spawnImpl` is injectable so tests
 * assert the contract without forking processes.
 */
import { spawn } from "node:child_process";
import { newSessionId } from "./ids.js";
import { fleetRoot } from "./paths.js";
import { SessionStore, type SessionMeta } from "./store.js";

export interface DispatchDetachedOptions {
  /** Working directory the session's agent will edit (and whose fleet it joins). */
  cwd: string;
  prompt: string;
  model?: string;
  agent?: string;
  /** Default "conversation": the worker stays alive for follow-ups via `fleet send`. */
  mode?: SessionMeta["mode"];
  /** Injectable store (defaults to the fleet store for `cwd`). */
  store?: SessionStore;
  /** Injectable spawner for tests. Must mirror child_process.spawn's shape. */
  spawnImpl?: (
    command: string,
    args: string[],
    options: { cwd: string; detached: boolean; stdio: "ignore" },
  ) => { unref: () => void; pid?: number | undefined };
}

/** Session titles are the prompt's first breath — same clip rule fleet-wide. */
export function titleFromPrompt(prompt: string): string {
  const one = prompt.replace(/\s+/g, " ").trim();
  return one.length > 64 ? one.slice(0, 61) + "…" : one;
}

/**
 * The REPL's shell-familiar backgrounding idiom: a prompt ending in ` &`
 * dispatches to the fleet instead of running inline. Returns the prompt with
 * the marker stripped, or null when the text is not a background dispatch
 * (no marker, slash/shell command, or nothing left once stripped —
 * plain "&" should reach the model, not spawn an empty session).
 */
export function parseAmpersandDispatch(text: string): string | null {
  if (text.startsWith("/") || text.startsWith("!")) return null;
  if (!/\s&$/.test(text)) return null;
  const prompt = text.replace(/\s*&$/, "").trim();
  return prompt === "" ? null : prompt;
}

/**
 * Create the session and launch its detached worker. Returns as soon as the
 * worker is spawned — typically well under 50 ms; the session streams into
 * the store from there.
 */
export async function dispatchDetachedSession(
  opts: DispatchDetachedOptions,
): Promise<{ sid: string; title: string }> {
  const prompt = opts.prompt.trim();
  if (prompt === "") throw new Error("dispatch needs a non-empty prompt");
  const entry = process.argv[1];
  if (opts.spawnImpl === undefined && (entry === undefined || entry === "")) {
    throw new Error("cannot locate the oxagen entry script to spawn a worker");
  }

  const store = opts.store ?? new SessionStore({ root: fleetRoot(opts.cwd) });
  const sid = newSessionId();
  const title = titleFromPrompt(prompt);
  await store.createSession({
    sid,
    title,
    prompt,
    owner: "worker",
    pid: 0,
    cwd: opts.cwd,
    mode: opts.mode ?? "conversation",
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
  });

  const spawnImpl = opts.spawnImpl ?? spawn;
  const child = spawnImpl(
    process.execPath,
    [...process.execArgv, entry as string, "fleet", "worker", sid],
    { cwd: opts.cwd, detached: true, stdio: "ignore" },
  );
  child.unref();
  return { sid, title };
}
