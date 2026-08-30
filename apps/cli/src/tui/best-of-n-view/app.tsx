/**
 * Best-of-N live view — the multi-lane race the user watches while N candidates
 * solve the same task in parallel and one is chosen. The whole point is
 * VISIBILITY: in a CLI with little to look at, seeing five lanes tick through
 * "editing… → running tests… → done ✓" and then a winner get crowned tells the
 * user the system is alive and working, not frozen.
 *
 * Driven entirely by the {@link BestOfNEvent} stream via an EventEmitter, so the
 * same events feed this view (TTY) or stream-json (headless) — one source of truth.
 */
import React, { useEffect, useReducer } from "react";
import { Box, Text, useApp } from "ink";
import type { EventEmitter } from "node:events";
import { theme } from "../theme.js";
import type { BestOfNEvent } from "../../agent/best-of-n.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

type LaneStatus = "running" | "verifying" | "done" | "failed";
interface Lane {
  id: string;
  model: string;
  status: LaneStatus;
  label: string;
  steps: number;
  files: number;
  testsPassed: boolean | null;
  error?: string;
}
interface State {
  total: number;
  prompt: string;
  lanes: Map<string, Lane>;
  phase: "running" | "selecting" | "done";
  viable: number;
  winnerId: string | null;
  reasoning: string;
  ranking: Array<{ id: string; score: number; note: string }>;
  applied: boolean;
  applyError?: string;
  warnings: string[];
  frame: number;
}

type Action =
  | { kind: "event"; e: BestOfNEvent }
  | { kind: "tick" }
  | { kind: "finish" };

function laneOf(s: State, id: string, model = ""): Lane {
  return (
    s.lanes.get(id) ?? {
      id,
      model,
      status: "running",
      label: "starting…",
      steps: 0,
      files: 0,
      testsPassed: null,
    }
  );
}

function reducer(s: State, a: Action): State {
  if (a.kind === "tick") return { ...s, frame: s.frame + 1 };
  if (a.kind === "finish") return { ...s, phase: "done" };
  const e = a.e;
  const lanes = new Map(s.lanes);
  switch (e.type) {
    case "start":
      return { ...s, total: e.candidates, prompt: e.prompt };
    case "candidate-start":
      lanes.set(e.id, {
        ...laneOf(s, e.id, e.model),
        model: e.model,
        status: "running",
        label: "starting…",
      });
      return { ...s, lanes };
    case "candidate-progress": {
      const l = laneOf(s, e.id);
      lanes.set(e.id, { ...l, label: e.label, steps: l.steps + 1 });
      return { ...s, lanes };
    }
    case "candidate-verify":
      lanes.set(e.id, {
        ...laneOf(s, e.id),
        status: "verifying",
        label: `verifying · ${e.command}`,
      });
      return { ...s, lanes };
    case "candidate-done":
      lanes.set(e.id, {
        ...laneOf(s, e.id),
        status: "done",
        label: "done",
        steps: e.steps,
        files: e.changedFiles.length,
        testsPassed: e.testsPassed,
      });
      return { ...s, lanes };
    case "candidate-failed":
      lanes.set(e.id, {
        ...laneOf(s, e.id),
        status: "failed",
        label: "failed",
        error: e.error,
      });
      return { ...s, lanes };
    case "select-start":
      return { ...s, phase: "selecting", viable: e.viable };
    case "select-done":
      return {
        ...s,
        winnerId: e.winnerId,
        reasoning: e.reasoning,
        ranking: e.ranking,
      };
    case "applied":
      return { ...s, applied: true };
    case "apply-failed":
      return { ...s, applyError: e.error };
    case "warning":
      return { ...s, warnings: [...s.warnings, e.message] };
    default:
      return s;
  }
}

function StatusGlyph({
  lane,
  frame,
}: {
  lane: Lane;
  frame: number;
}): React.JSX.Element {
  if (lane.status === "done")
    return (
      <Text color={lane.testsPassed === false ? "yellow" : "green"}>
        {lane.testsPassed === false ? "✗" : "✓"}
      </Text>
    );
  if (lane.status === "failed") return <Text color="red">✗</Text>;
  return <Text color={theme.cyan}>{SPINNER[frame % SPINNER.length]}</Text>;
}

function LaneRow({
  index,
  lane,
  frame,
}: {
  index: number;
  lane: Lane;
  frame: number;
}): React.JSX.Element {
  const tag =
    lane.status === "done"
      ? `${lane.files} file${lane.files === 1 ? "" : "s"} · ${lane.steps} steps${lane.testsPassed === true ? " · tests ✓" : lane.testsPassed === false ? " · tests ✗" : ""}`
      : lane.status === "failed"
        ? (lane.error ?? "error").slice(0, 48)
        : lane.label.slice(0, 48);
  const dim = lane.status === "done" || lane.status === "failed";
  return (
    <Box>
      <Text>{"  "}</Text>
      <Text color={theme.violet}>{CIRCLED[index] ?? `(${index + 1})`}</Text>
      <Text> </Text>
      <StatusGlyph lane={lane} frame={frame} />
      <Text color={dim ? theme.dim : undefined}> {tag}</Text>
      <Text color={theme.dim}>
        {lane.model ? `   ${lane.model.split("/").pop()}` : ""}
      </Text>
    </Box>
  );
}

export interface BestOfNAppProps {
  emitter: EventEmitter;
  total: number;
  prompt: string;
}

export function BestOfNApp({
  emitter,
  total,
  prompt,
}: BestOfNAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, {
    total,
    prompt,
    lanes: new Map(),
    phase: "running",
    viable: 0,
    winnerId: null,
    reasoning: "",
    ranking: [],
    applied: false,
    warnings: [],
    frame: 0,
  });

  useEffect(() => {
    const onEvent = (e: BestOfNEvent): void => dispatch({ kind: "event", e });
    const onDone = (): void => {
      dispatch({ kind: "finish" });
      // Let the final frame paint, then exit.
      setTimeout(() => exit(), 80);
    };
    emitter.on("event", onEvent);
    emitter.on("done", onDone);
    return () => {
      emitter.off("event", onEvent);
      emitter.off("done", onDone);
    };
  }, [emitter, exit]);

  // Spinner tick while anything is still moving.
  useEffect(() => {
    if (state.phase === "done") return;
    const t = setInterval(() => dispatch({ kind: "tick" }), 90);
    return () => clearInterval(t);
  }, [state.phase]);

  const lanes = Array.from(
    { length: Math.max(state.total, state.lanes.size) },
    (_, i) => state.lanes.get(`candidate-${i + 1}`),
  );

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box>
        <Text color={theme.cyan}>🏁 </Text>
        <Text bold>Best-of-{state.total}</Text>
        <Text color={theme.dim}> · {state.prompt.slice(0, 60)}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {lanes.map((lane, i) =>
          lane ? (
            <LaneRow key={i} index={i} lane={lane} frame={state.frame} />
          ) : (
            <Box key={i}>
              <Text color={theme.dim}>
                {"  "}
                {CIRCLED[i] ?? `(${i + 1})`} ⋯ queued…
              </Text>
            </Box>
          ),
        )}
      </Box>

      {state.warnings.map((w, i) => (
        <Box key={`warn-${i}`} marginTop={1}>
          <Text color="yellow">⚠ {w}</Text>
        </Box>
      ))}

      {state.phase === "selecting" && !state.winnerId && (
        <Box marginTop={1}>
          <Text color={theme.cyan}>⚖ </Text>
          <Text>
            judging {state.viable} viable candidate
            {state.viable === 1 ? "" : "s"}…{" "}
          </Text>
          <Text color={theme.cyan}>
            {SPINNER[state.frame % SPINNER.length]}
          </Text>
        </Box>
      )}

      {state.winnerId && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="green">🏆 {state.winnerId} wins</Text>
            <Text color={theme.dim}> — {state.reasoning.slice(0, 80)}</Text>
          </Box>
          {state.ranking.length > 0 && (
            <Box>
              <Text color={theme.dim}>
                {"   "}
                {[...state.ranking]
                  .sort((a, b) => b.score - a.score)
                  .map((r) => `${r.id.replace("candidate-", "#")}:${r.score}`)
                  .join("  ")}
              </Text>
            </Box>
          )}
          {state.applied && (
            <Text color="green">{"   "}✓ applied to your working tree</Text>
          )}
          {state.applyError && (
            <Text color="yellow">
              {"   "}⚠ could not apply cleanly — see the winning diff
            </Text>
          )}
        </Box>
      )}

      {state.phase === "done" && !state.winnerId && (
        <Box marginTop={1}>
          <Text color="yellow">No candidate produced a viable change.</Text>
        </Box>
      )}
    </Box>
  );
}
