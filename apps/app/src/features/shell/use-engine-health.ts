"use client";
// Whether stella's engine can take a turn, known before the first question
// (#3227). The flyout reads `get_assistant_engine` when it opens, when the
// window takes focus again, and when the person presses Check again. While the
// engine reports any state but `ready`, the flyout holds Send and says why
// (assistant-engine-notice.tsx), and the draft stays where it is.
//
// A read that fails is not an answer. The action can be refused, or the
// network between the browser and the app can drop, and neither says anything
// about the engine. So a failed read keeps the last answer, or none, and Send
// is held only on an answer that names a state other than `ready`. A turn
// asked while nothing is known still reports an engine it cannot reach.
//
// Answers are kept per workspace, the way the flyout keeps its threads: the
// read is scoped, and the person can move between workspaces with the panel
// open. Nothing polls (#3805). A read goes out on an open, a focus, or a
// press, and never on a timer.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantEngine } from "@/data/contracts/shell";
import { readAssistantEngine } from "./engine-actions";

/**
 * How long an answer stands before an open or a focus reads the engine again:
 * 15 seconds.
 *
 * Each read runs the engine's readiness probe on the server, up to three
 * requests at the engine, and against a down engine it holds a server request
 * for up to seven seconds. People open and close the panel, and move between
 * windows, far more often than that. Without a cache each of those would probe
 * the engine again. Fifteen seconds bounds it to one probe per workspace in
 * any 15 seconds, and a recovered engine still shows within 15 seconds of the
 * next open or focus. Check again skips the cache, because a person asking is
 * a reason to look now.
 *
 * @internal Exported for its test; nothing outside this module imports it.
 */
export const ENGINE_HEALTH_TTL_MS = 15_000;

/** A state the engine reported that takes no turn. */
export type EngineDown = Exclude<AssistantEngine["state"], "ready">;

export type EngineHealth = {
  /** The state holding Send, or null when the engine is ready or no read has answered. */
  down: EngineDown | null;
  /** The last failed probe's code while the engine is down, such as `ECONNREFUSED`. */
  error: string | null;
  /** A read is out for this workspace. */
  checking: boolean;
  /** Read the engine now, past the cache. Resolves true when it answered `ready`. */
  check: () => Promise<boolean>;
};

/** What the panel shows for one workspace: the last answer, and whether a read is out. */
type Shown = { engine: AssistantEngine | null; checking: boolean };

/** When one workspace's last answer landed, and the read that is out, if one is. */
type Gate = {
  answeredAt: number;
  out: Promise<AssistantEngine | null> | null;
};

const NO_GATE: Gate = { answeredAt: Number.NEGATIVE_INFINITY, out: null };

function withShown(
  prior: ReadonlyMap<string, Shown>,
  key: string,
  change: (was: Shown) => Shown,
): ReadonlyMap<string, Shown> {
  const next = new Map(prior);
  next.set(key, change(prior.get(key) ?? { engine: null, checking: false }));
  return next;
}

export function useEngineHealth(
  org: string | null,
  ws: string | null,
  open: boolean,
): EngineHealth {
  const [shown, setShown] = useState<ReadonlyMap<string, Shown>>(
    () => new Map(),
  );
  // Read and written in effects and handlers only, never while rendering. An
  // open and a focus can land in the same tick, and the second has to see the
  // read the first sent rather than send its own.
  const gates = useRef(new Map<string, Gate>());

  /** Send a read for one workspace, or join the one that is out. Null when it failed. */
  const probe = useCallback(
    (inOrg: string, inWs: string): Promise<AssistantEngine | null> => {
      const key = `${inOrg}/${inWs}`;
      const gate = gates.current.get(key) ?? NO_GATE;
      if (gate.out !== null) return gate.out;
      setShown((prior) =>
        withShown(prior, key, (was) => ({ ...was, checking: true })),
      );
      const out = readAssistantEngine(inOrg, inWs)
        .then(
          (result) => (result.ok ? result.value : null),
          () => null,
        )
        .then((engine) => {
          // A failed read leaves the cache as it was, so the next open or
          // focus tries again rather than trusting an answer it never got.
          gates.current.set(key, {
            answeredAt: engine === null ? gate.answeredAt : Date.now(),
            out: null,
          });
          setShown((prior) =>
            withShown(prior, key, (was) => ({
              engine: engine ?? was.engine,
              checking: false,
            })),
          );
          return engine;
        });
      gates.current.set(key, { answeredAt: gate.answeredAt, out });
      return out;
    },
    [],
  );

  useEffect(() => {
    if (!open || org === null || ws === null) return;
    const readIfStale = () => {
      const gate = gates.current.get(`${org}/${ws}`) ?? NO_GATE;
      if (Date.now() - gate.answeredAt < ENGINE_HEALTH_TTL_MS) return;
      void probe(org, ws);
    };
    readIfStale();
    window.addEventListener("focus", readIfStale);
    return () => {
      window.removeEventListener("focus", readIfStale);
    };
  }, [open, org, ws, probe]);

  const check = useCallback(async (): Promise<boolean> => {
    if (org === null || ws === null) return false;
    const engine = await probe(org, ws);
    return engine?.state === "ready";
  }, [org, ws, probe]);

  const here =
    org === null || ws === null ? undefined : shown.get(`${org}/${ws}`);
  const engine = here?.engine ?? null;
  const checking = here?.checking ?? false;
  if (engine === null || engine.state === "ready")
    return { down: null, error: null, checking, check };
  return { down: engine.state, error: engine.error, checking, check };
}
