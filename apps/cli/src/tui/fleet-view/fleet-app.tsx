/**
 * Fleet App — root of the agents screen.
 *
 * Lets the user watch an army of coding subagents work the local tree at once and
 * dispatch more. It subscribes to the {@link Fleet}'s "update" event to drive
 * React state, and also runs a steady 100ms frame timer so running-agent spinners
 * and elapsed timers animate smoothly between events. The header shows live fleet
 * vitals, the roster lists every agent, and the dispatch line adds ad-hoc agents.
 *
 * Keys (handled at this level): typing edits the dispatch line · Enter dispatches
 * a new agent · Ctrl-T toggles per-agent detail · Ctrl-C cancels all in-flight
 * agents and exits.
 */
import { Box, Text, useApp, useInput } from "ink";
import React, { useState, useEffect } from "react";
import { FleetSummary } from "./fleet-summary.js";
import { AgentRow, RosterHeader } from "./agent-row.js";
import { DispatchInput } from "./dispatch-input.js";
import type { Fleet } from "../../agent/fleet/orchestrator.js";
import type { FleetSnapshot, Plan } from "../../agent/fleet/types.js";

/** Braille spinner frames for the planning state (matches the agent rows). */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Phase = "planning" | "running" | "error";

export function FleetApp({
  fleet,
  goal,
  plan,
}: {
  fleet: Fleet;
  /** When set, the screen plans this goal into tasks before running. */
  goal?: string;
  /** Produce + persist the plan for `goal`. Throws on a missing gateway key. */
  plan?: (signal: AbortSignal) => Promise<Plan>;
}): React.ReactElement {
  const { exit } = useApp();
  const [snap, setSnap] = useState<FleetSnapshot>(() => fleet.snapshot());
  const [frame, setFrame] = useState(0);
  const [phase, setPhase] = useState<Phase>(goal && plan ? "planning" : "running");
  const [error, setError] = useState("");
  const [showDetail, setShowDetail] = useState(false);

  // Drive re-render from fleet events and from a steady animation tick (so the
  // running spinners advance even when no "update" has fired recently).
  useEffect(() => {
    const onUpdate = (s: FleetSnapshot): void => setSnap(s);
    fleet.on("update", onUpdate);
    const id = setInterval(() => setFrame((f) => f + 1), 100);
    return () => {
      fleet.off("update", onUpdate);
      clearInterval(id);
    };
  }, [fleet]);

  // Plan (if a goal was given), then start the fleet. Runs once on mount.
  useEffect(() => {
    if (!goal || !plan) {
      void fleet.start();
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const planned = await plan(controller.signal);
        if (cancelled) return;
        fleet.loadPlan(planned);
        void fleet.start();
        setPhase("running");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fleet, goal, plan]);

  // On a fatal planning error, paint the message frame, then leave.
  useEffect(() => {
    if (phase !== "error") return;
    const id = setTimeout(() => exit(), 40);
    return () => clearTimeout(id);
  }, [phase, exit]);

  // App-level keys: Ctrl-C cancels everything and quits; Ctrl-T toggles detail.
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      fleet.cancelAll();
      exit();
      return;
    }
    if (key.ctrl && input === "t") {
      setShowDetail((d) => !d);
    }
  });

  if (phase === "error") {
    return (
      <Box paddingX={1} marginY={1}>
        <Text color="#F87171" bold>
          ✗{" "}
        </Text>
        <Text wrap="wrap">{error}</Text>
      </Box>
    );
  }

  const agents = snap.agents;

  return (
    <Box flexDirection="column" paddingX={1}>
      <FleetSummary snap={snap} />

      {phase === "planning" ? (
        <Box paddingX={1} marginBottom={1}>
          <Text color="#FBBF24" bold>
            {SPINNER[frame % SPINNER.length] ?? "⠋"}{" "}
          </Text>
          <Text color="#FBBF24">Planning </Text>
          <Text dimColor wrap="truncate">
            {goal}
          </Text>
          <Text dimColor> …</Text>
        </Box>
      ) : null}

      {agents.length > 0 ? <RosterHeader /> : null}
      {agents.length === 0 && phase !== "planning" ? (
        <Box paddingX={1} marginBottom={1}>
          <Text dimColor>No agents yet — type a task below and press Enter.</Text>
        </Box>
      ) : null}
      {agents.map((a) => (
        <AgentRow
          key={a.taskId}
          agent={a}
          frame={frame}
          showDetail={showDetail}
        />
      ))}

      <Box marginTop={1}>
        <DispatchInput
          onDispatch={(text) => {
            fleet.dispatchPrompt(text);
          }}
        />
      </Box>

      <Box paddingX={1} justifyContent="space-between">
        <Box gap={2}>
          <Text dimColor>
            <Text bold>enter</Text> dispatch agent
          </Text>
          <Text dimColor>
            <Text bold>ctrl+t</Text> {showDetail ? "hide" : "show"} detail
          </Text>
        </Box>
        <Text dimColor>
          <Text bold>ctrl+c</Text> cancel all · quit
        </Text>
      </Box>
    </Box>
  );
}
