/**
 * mission-control-app.tsx — the root of the fleet Mission Control TUI (spec §5,
 * ADR-023).
 *
 * One screen for a whole fleet of agent sessions: a vitals band, a selectable
 * session rail, a three-mode main pane (Aggregate timeline / Focus transcript /
 * Roster table), and an always-present composer that dispatches new work or
 * follows up with a running session — never blocked, because `manager.dispatch`
 * returns synchronously (ADR-023 decision 4).
 *
 * ## One keyboard owner
 *
 * Ink delivers every keystroke to EVERY mounted `useInput`, so this component is
 * the SOLE input handler — the composer and every pane are presentational. That
 * lets a single rule reconcile "the composer is always focused for text" with
 * "bare letters switch views": the view/toggle letters (a/f/r/v/c/n, digits) are
 * live only while the composer is EMPTY; the moment there is text, every
 * printable key is inserted, so any prompt is typeable. Non-text keys (tab,
 * arrows, esc, ctrl-c) are always global.
 *
 * ## Rendering discipline
 *
 * The merged event flood mutates refs (the timeline's line ring, the per-session
 * live tails) and re-renders through the shared render throttle (~30fps); a
 * separate 100ms tick animates elapsed clocks. This is the same coalescing the
 * REPL transcript uses — N agents streaming can't out-run the frame budget.
 */
import { Box, Text, useApp, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { theme } from "../theme.js";
import {
  toAggregateLine,
  type AggregateEmphasis,
  type AggregateLine,
} from "./aggregate-line.js";
import { VitalsBar } from "./vitals-bar.js";
import { SessionRail } from "./session-rail.js";
import {
  AggregateTimeline,
  type LiveTail,
  type RenderableLine,
} from "./aggregate-timeline.js";
import { FocusTranscript } from "./focus-transcript.js";
import { RosterView } from "./roster-view.js";
import { Composer } from "./composer.js";
import {
  colorForSid,
  countByState,
  editLine,
  emptyLine,
  hasLiveTimers,
  parseAtRef,
  sumUsage,
  type LineState,
} from "./lib.js";
import { createRenderThrottle } from "../../repl/render-throttle.js";
import { useTerminalSize } from "../../repl/use-terminal-size.js";
import { resolveSidRef, shortSid } from "../../sessions/ids.js";
import type { SessionEvent } from "../../sessions/events.js";
import type { SessionMetaView, SessionStore } from "../../sessions/store.js";

/** Newest lines kept in the timeline ring; older ones live only on disk. */
const MAX_TIMELINE_LINES = 500;
/** Ceiling on pinned live tails so a huge fleet can't crowd out the feed. */
const MAX_TAILS = 6;

type Mode = "aggregate" | "focus" | "roster";

/**
 * The slice of {@link FleetSessionManager} this view drives. Declared
 * structurally so the real manager satisfies it AND a test can pass a plain
 * EventEmitter-backed fake with no cast.
 */
export interface ManagerHandle {
  on(event: "event", listener: (e: SessionEvent) => void): unknown;
  on(event: "roster", listener: (s: SessionMetaView[]) => void): unknown;
  off(event: "event", listener: (e: SessionEvent) => void): unknown;
  off(event: "roster", listener: (s: SessionMetaView[]) => void): unknown;
  dispatch(opts: {
    prompt: string;
    model?: string;
    agent?: string;
    mode?: "conversation" | "once";
  }): string;
  send(sid: string, text: string): Promise<void>;
  cancel(sid: string): Promise<void>;
  drain(): Promise<void>;
  rosterSnapshot(): SessionMetaView[];
}

export interface MissionControlAppProps {
  store: SessionStore;
  manager: ManagerHandle;
  cwd: string;
  focusSid?: string;
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

function ModeHeader({
  mode,
  verbose,
}: {
  mode: Mode;
  verbose: boolean;
}): React.ReactElement {
  const tab = (
    key: string,
    label: string,
    active: boolean,
  ): React.ReactElement => (
    <Text
      color={active ? theme.cyan : undefined}
      bold={active}
      dimColor={!active}
    >
      [{key}]{label}
    </Text>
  );
  return (
    <Box paddingX={1} gap={2}>
      {tab("a", "ggregate", mode === "aggregate")}
      {tab("f", "ocus", mode === "focus")}
      {tab("r", "oster", mode === "roster")}
      {verbose ? <Text color={theme.amber}>verbose</Text> : null}
    </Box>
  );
}

export function MissionControlApp({
  store,
  manager,
  cwd,
  focusSid,
}: MissionControlAppProps): React.ReactElement {
  const { exit } = useApp();
  const { rows, cols, fullscreen } = useTerminalSize();

  const [roster, setRoster] = useState<SessionMetaView[]>([]);
  const [selectedSid, setSelectedSid] = useState<string | null>(
    focusSid ?? null,
  );
  const [mode, setMode] = useState<Mode>(focusSid ? "focus" : "aggregate");
  const [verbose, setVerbose] = useState(false);
  const [line, setLine] = useState<LineState>(emptyLine);
  const [, setFrame] = useState(0);
  const [draining, setDraining] = useState(false);
  const [cancelArmed, setCancelArmed] = useState<string | null>(null);

  // The composer buffer's SYNCHRONOUS truth. Keystrokes can outpace renders
  // (a fast typist, a paste, a test), and the useInput closure only sees the
  // last-rendered `line` — so the "empty composer" letter-command check and
  // submit() must read this ref, or a mid-word character can be misread as a
  // view command (e.g. the 'c' of "@docs" arming cancel).
  const lineRef = useRef<LineState>(line);
  const applyLine = (next: LineState | ((l: LineState) => LineState)): void => {
    const resolved = typeof next === "function" ? next(lineRef.current) : next;
    lineRef.current = resolved;
    setLine(resolved);
  };

  // Event-flood state lives in refs (mutated synchronously per bus event) and
  // is committed through the throttle; see the module doc.
  const linesRef = useRef<RenderableLine[]>([]);
  const tailsRef = useRef<Map<string, string>>(new Map());
  const keyRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const verboseRef = useRef(verbose);
  verboseRef.current = verbose;
  const [, setTick] = useState(0);
  const throttleRef = useRef(
    createRenderThrottle<void>(() => setTick((t) => t + 1)),
  );

  const appendLine = (l: AggregateLine): void => {
    keyRef.current += 1;
    linesRef.current.push({ ...l, key: keyRef.current });
    if (linesRef.current.length > MAX_TIMELINE_LINES) {
      linesRef.current = linesRef.current.slice(-MAX_TIMELINE_LINES);
    }
  };
  const notice = (
    sid: string,
    text: string,
    emphasis: AggregateEmphasis,
  ): void => {
    appendLine({ sid, ts: Date.now(), text, emphasis });
    throttleRef.current.flush(() => undefined);
  };

  // Subscribe to the merged bus + roster once; seed from the current snapshot so
  // a roster emitted before mount (manager.start() runs before render) is not
  // missed.
  useEffect(() => {
    const throttle = throttleRef.current;
    const onEvent = (e: SessionEvent): void => {
      const al = toAggregateLine(e, { verbose: verboseRef.current });
      if (al) appendLine(al);
      if (e.type === "message.delta") {
        const prev = tailsRef.current.get(e.sid) ?? "";
        tailsRef.current.set(
          e.sid,
          (prev + e.text).replace(/\s+/g, " ").slice(-200),
        );
      } else if (
        e.type === "message.end" ||
        e.type === "turn.end" ||
        e.type === "session.end" ||
        (e.type === "session.state" && e.state !== "running")
      ) {
        tailsRef.current.delete(e.sid);
      }
      throttle.schedule(() => undefined);
    };
    const onRoster = (sessions: SessionMetaView[]): void => {
      setRoster(sessions);
      setSelectedSid((cur) =>
        cur && sessions.some((s) => s.sid === cur)
          ? cur
          : sessions.length > 0
            ? (sessions[0] as SessionMetaView).sid
            : null,
      );
    };

    manager.on("event", onEvent);
    manager.on("roster", onRoster);

    const initial = manager.rosterSnapshot();
    if (initial.length > 0) {
      setRoster(initial);
      setSelectedSid((cur) => cur ?? (initial[0] as SessionMetaView).sid);
    }

    return () => {
      manager.off("event", onEvent);
      manager.off("roster", onRoster);
      throttle.cancel();
    };
  }, [manager]);

  // Animation tick for the live elapsed clocks. The state glyphs are static and
  // the clocks resolve to whole seconds (formatElapsed), so one tick per second
  // is all the display needs — and only while something is actually counting.
  // When the fleet is idle (no active session, not draining) nothing changes
  // second-to-second, so we schedule no interval at all rather than redraw an
  // identical frame forever. The clocks are computed from `Date.now()`, so when
  // work resumes the tick restarts and every elapsed value is correct with no
  // drift from the paused stretch.
  const animating = hasLiveTimers(roster, draining);
  useEffect(() => {
    if (!animating) return;
    const id = setInterval(() => setFrame((f) => f + 1), 1000);
    return () => clearInterval(id);
  }, [animating]);

  // ── Selection ──────────────────────────────────────────────────────────────

  const moveSelection = (delta: number, wrap: boolean): void => {
    if (roster.length === 0) return;
    const idx = roster.findIndex((s) => s.sid === selectedSid);
    const base = idx < 0 ? 0 : idx;
    let next = base + delta;
    if (wrap) next = (next + roster.length) % roster.length;
    else next = Math.max(0, Math.min(roster.length - 1, next));
    setSelectedSid((roster[next] as SessionMetaView).sid);
  };
  const jumpSelection = (index: number): void => {
    if (index >= 0 && index < roster.length)
      setSelectedSid((roster[index] as SessionMetaView).sid);
  };

  // ── Composer submit ──────────────────────────────────────────────────────────

  const dispatchNew = (prompt: string): void => {
    const sid = manager.dispatch({ prompt });
    setSelectedSid(sid);
    notice(sid, `◇ dispatched ${shortSid(sid)}`, "success");
  };
  const sendTo = (sid: string, text: string): void => {
    void manager.send(sid, text).catch(() => {});
    notice(sid, `◇ sent → ${shortSid(sid)}`, "dim");
  };
  const routeAt = (ref: string, rest: string): void => {
    const resolved = resolveSidRef(
      ref,
      roster.map((s) => s.sid),
    );
    if (!resolved) {
      appendLine({
        sid: "-",
        ts: Date.now(),
        text: `✗ no session matches @${ref}`,
        emphasis: "error",
      });
      throttleRef.current.flush(() => undefined);
      return;
    }
    if (rest === "") {
      setSelectedSid(resolved);
      setMode("focus");
      return;
    }
    sendTo(resolved, rest);
  };

  const submit = (): void => {
    const raw = lineRef.current.value.trim();
    if (raw === "") return;
    const at = parseAtRef(raw);
    if (at) {
      routeAt(at.ref, at.rest);
    } else if (mode === "focus" && selectedSid) {
      sendTo(selectedSid, raw);
    } else {
      dispatchNew(raw);
    }
    applyLine(emptyLine());
    setCancelArmed(null);
  };

  // ── Cancel / quit ────────────────────────────────────────────────────────────

  const armOrConfirmCancel = (): void => {
    if (!selectedSid) return;
    if (cancelArmed === selectedSid) {
      void manager.cancel(selectedSid).catch(() => {});
      notice(selectedSid, "◼ cancel requested", "dim");
      setCancelArmed(null);
    } else {
      setCancelArmed(selectedSid);
    }
  };

  const handleCtrlC = (): void => {
    if (draining) {
      exit();
      return;
    }
    setDraining(true);
    void manager.drain().then(() => exit());
  };

  // ── The single keyboard handler ──────────────────────────────────────────────

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      handleCtrlC();
      return;
    }
    // Always-global, non-text navigation.
    if (key.tab) {
      moveSelection(key.shift ? -1 : 1, true);
      return;
    }
    if (key.escape) {
      if (mode === "focus") setMode("aggregate");
      setCancelArmed(null);
      return;
    }
    if (key.upArrow) {
      moveSelection(-1, false);
      return;
    }
    if (key.downArrow) {
      moveSelection(1, false);
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    // Line editing (always operates on the buffer).
    if (key.leftArrow) return void applyLine((l) => editLine(l, { t: "left" }));
    if (key.rightArrow)
      return void applyLine((l) => editLine(l, { t: "right" }));
    if (key.backspace)
      return void applyLine((l) => editLine(l, { t: "backspace" }));
    if (key.delete) return void applyLine((l) => editLine(l, { t: "delete" }));
    if (key.ctrl && input === "a")
      return void applyLine((l) => editLine(l, { t: "home" }));
    if (key.ctrl && input === "e")
      return void applyLine((l) => editLine(l, { t: "end" }));
    if (key.ctrl && input === "u") return void applyLine(emptyLine());

    // Bare-letter view commands — only on an EMPTY composer (see module doc).
    // Read the ref, not the render-captured state: see lineRef above.
    if (lineRef.current.value === "" && !key.ctrl && !key.meta) {
      switch (input) {
        case "a":
          return void setMode("aggregate");
        case "f":
          if (selectedSid) setMode("focus");
          return;
        case "r":
          return void setMode("roster");
        case "v":
          return void setVerbose((v) => !v);
        case "c":
          return void armOrConfirmCancel();
        case "n":
          setMode("aggregate");
          return;
        default:
          if (input >= "1" && input <= "9")
            return void jumpSelection(Number(input) - 1);
      }
    }

    // Everything else printable → the composer.
    if (input && !key.ctrl && !key.meta) {
      applyLine((l) => editLine(l, { t: "insert", ch: input }));
      if (cancelArmed) setCancelArmed(null);
    }
  });

  // ── Derived render data ──────────────────────────────────────────────────────

  const now = Date.now();
  const counts = countByState(roster);
  const usage = sumUsage(roster);
  const tails: LiveTail[] = [...tailsRef.current.entries()]
    .slice(-MAX_TAILS)
    .map(([sid, text]) => ({ sid, text }));

  const railWidth = 28;
  const chromeRows =
    1 /* vitals */ + 1 /* mode header */ + 4 /* composer + hint + notice */;
  const mainRows = Math.max(3, (fullscreen ? rows : 24) - chromeRows);

  const focusTarget =
    mode === "focus" && selectedSid
      ? {
          targetLabel: `focus ${shortSid(selectedSid)}`,
          targetColor: colorForSid(selectedSid),
        }
      : undefined;

  const placeholder =
    mode === "focus" && selectedSid
      ? `reply to ${shortSid(selectedSid)} — enter to send`
      : "type a task and press enter — every line becomes an agent";

  const hint =
    "enter dispatch · @sid msg → send · tab select · a/f/r views · v verbose · c cancel · ^c quit";

  const showEmptyState = roster.length === 0 && linesRef.current.length === 0;

  return (
    <Box
      flexDirection="column"
      width={cols}
      {...(fullscreen ? { height: rows } : {})}
    >
      <VitalsBar
        counts={counts}
        usage={usage}
        project={projectName(cwd)}
        elapsedMs={now - startedAtRef.current}
        draining={draining}
        drainingCount={counts.running}
      />

      <Box flexGrow={1}>
        {roster.length > 0 ? (
          <SessionRail
            sessions={roster}
            selectedSid={selectedSid}
            width={railWidth}
            now={now}
          />
        ) : null}

        <Box flexDirection="column" flexGrow={1}>
          <ModeHeader mode={mode} verbose={verbose} />
          {showEmptyState ? (
            <Box
              flexGrow={1}
              alignItems="center"
              justifyContent="center"
              paddingX={1}
            >
              <Text dimColor>
                type a task and press enter — every line becomes an agent
              </Text>
            </Box>
          ) : mode === "aggregate" ? (
            <AggregateTimeline
              lines={linesRef.current}
              tails={tails}
              rows={mainRows}
            />
          ) : mode === "focus" ? (
            selectedSid ? (
              <FocusTranscript
                sid={selectedSid}
                store={store}
                bus={manager}
                rows={mainRows}
              />
            ) : (
              <Box paddingX={1}>
                <Text dimColor>No session selected — tab to pick one.</Text>
              </Box>
            )
          ) : (
            <RosterView sessions={roster} selectedSid={selectedSid} now={now} />
          )}
        </Box>
      </Box>

      {cancelArmed ? (
        <Box paddingX={1}>
          <Text color={theme.red}>
            press c again to cancel {shortSid(cancelArmed)}
          </Text>
        </Box>
      ) : null}

      <Composer
        value={line.value}
        cursor={line.cursor}
        placeholder={placeholder}
        {...(focusTarget ?? {})}
        hint={hint}
      />
    </Box>
  );
}
