/**
 * focus-transcript.tsx — the [F]ocus main pane: one session's full transcript,
 * live (spec §5).
 *
 * On focus (or a change of focused session) it replays the session's log from
 * disk ONCE via `readEvents`, then live-appends every new event for that sid off
 * the manager bus — the same replay-then-tail shape the store gives a second
 * terminal, so a foreign session reads identically to an owned one. Events are
 * folded (lib.ts `foldFocusEvents`) into transcript items and rendered: user
 * prompts in the `›` voice, finished assistant answers through the vendored
 * Markdown renderer, and tool/stage/diff/error/end as compact chips.
 *
 * Re-renders under the event flood are coalesced through the shared render
 * throttle (~30fps), exactly like the REPL transcript.
 */
import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { theme } from "../theme.js";
import { Markdown } from "../markdown.js";
import { createRenderThrottle } from "../../repl/render-throttle.js";
import type { SessionEvent } from "../../sessions/events.js";
import { foldFocusEvents, formatDurationMs, type FocusItem } from "./lib.js";

/** The slice of the store this view needs — a session's events on disk. */
export interface FocusEventSource {
  readEvents(sid: string): Promise<SessionEvent[]>;
}

/** The slice of the manager this view needs — the live merged event bus. */
export interface FocusEventBus {
  on(event: "event", listener: (e: SessionEvent) => void): unknown;
  off(event: "event", listener: (e: SessionEvent) => void): unknown;
}

function ToolChip({
  item,
}: {
  item: Extract<FocusItem, { kind: "tool" }>;
}): React.ReactElement {
  if (item.running) return <Text dimColor>· {item.name} …</Text>;
  if (item.ok === false) {
    return (
      <Text color={theme.red}>
        ✗ {item.name} failed
        {item.durationMs !== undefined
          ? ` after ${formatDurationMs(item.durationMs)}`
          : ""}
      </Text>
    );
  }
  return (
    <Text dimColor>
      · {item.name}
      {item.durationMs !== undefined
        ? ` ${formatDurationMs(item.durationMs)}`
        : ""}
    </Text>
  );
}

function TranscriptItem({ item }: { item: FocusItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={theme.cyan} bold>
            ›{" "}
          </Text>
          <Text bold wrap="wrap">
            {item.text}
          </Text>
        </Box>
      );
    case "assistant":
      return item.streaming ? (
        <Text wrap="wrap">{item.text}</Text>
      ) : (
        <Markdown>{item.text}</Markdown>
      );
    case "tool":
      return <ToolChip item={item} />;
    case "stage":
      return (
        <Text dimColor>
          {item.label}
          {item.detail !== undefined ? ` — ${item.detail}` : ""}
        </Text>
      );
    case "diff": {
      const shown = item.changedFiles.slice(0, 3).join(", ");
      const more =
        item.changedFiles.length > 3 ? ` +${item.changedFiles.length - 3}` : "";
      return (
        <Text color={theme.green}>
          ± {item.changedLines} lines · {shown}
          {more}
        </Text>
      );
    }
    case "error":
      return <Text color={theme.red}>✗ {item.message}</Text>;
    case "end": {
      const color =
        item.state === "done"
          ? theme.green
          : item.state === "failed"
            ? theme.red
            : theme.dim;
      const mark =
        item.state === "done" ? "✔" : item.state === "failed" ? "✖" : "◼";
      return (
        <Box marginTop={1}>
          <Text color={color} bold>
            {mark} {item.state}
            {item.summary ? ` — ${item.summary}` : ""}
          </Text>
        </Box>
      );
    }
  }
}

export function FocusTranscript({
  sid,
  store,
  bus,
  rows,
}: {
  sid: string;
  store: FocusEventSource;
  bus: FocusEventBus;
  /** Max transcript items to show; the newest win. */
  rows: number;
}): React.ReactElement {
  const eventsRef = useRef<SessionEvent[]>([]);
  const [, setTick] = useState(0);
  const throttleRef = useRef(
    createRenderThrottle<void>(() => setTick((t) => t + 1)),
  );

  useEffect(() => {
    const throttle = throttleRef.current;
    let cancelled = false;
    eventsRef.current = [];
    setTick((t) => t + 1);

    // Live events that land while the disk read is in flight are merged (not
    // lost) by deduping on seq once the replay resolves.
    const onEvent = (e: SessionEvent): void => {
      if (e.sid !== sid) return;
      eventsRef.current.push(e);
      throttle.schedule(() => undefined);
    };
    bus.on("event", onEvent);

    void store.readEvents(sid).then((disk) => {
      if (cancelled) return;
      const bySeq = new Map<number, SessionEvent>();
      for (const e of disk) bySeq.set(e.seq, e);
      for (const e of eventsRef.current) bySeq.set(e.seq, e);
      eventsRef.current = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      throttle.flush(() => undefined);
    });

    return () => {
      cancelled = true;
      bus.off("event", onEvent);
      throttle.cancel();
    };
  }, [sid, store, bus]);

  const items = foldFocusEvents(eventsRef.current).slice(-rows);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {items.length === 0 ? (
        <Text dimColor>No transcript yet for this session.</Text>
      ) : (
        items.map((item, i) => <TranscriptItem key={i} item={item} />)
      )}
    </Box>
  );
}
