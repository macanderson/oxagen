import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import {
  ApprovalPrompt,
  humanizeTokens,
  modeLabel,
  MessageView,
  PromptInput,
  renderInvadersLane,
  SpaceInvaders,
  StatusLine,
  StageBadge,
  STAGE_GLYPH,
  STAGE_COLOR,
  STAGE_LABEL,
  ThinkingIndicator,
  TurnSummaryView,
  type Message,
} from "../components.js";
import type { SlashCatalogEntry } from "../../slash/catalog.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
} from "../../agent/permissions.js";
import type { StageKind } from "../../agent/trace.js";

/**
 * Every stage the pipeline is known to emit today, in execution order. Keep in
 * sync with the canonical StageKind union (packages/agent-engine/src/trace/types.ts,
 * re-exported via apps/cli/src/agent/trace.ts) — see
 * agent/__tests__/stage-kind-exhaustive.test.ts for the companion PHASE_LABEL
 * check and the source guard against a hand-copied StageKind reappearing.
 */
const KNOWN_STAGE_KINDS: readonly StageKind[] = [
  "evaluate",
  "plan",
  "enhance",
  "route",
  "execute",
  "judge",
  "revise",
  "complete",
];

const sampleReq: ApprovalRequest = {
  tool: "bash",
  command: "rm -rf build",
  cwd: "/x",
  summary: "Run: rm -rf build",
  reason: "command matches a dangerous pattern",
};

/**
 * Ink delivers stdin to useInput asynchronously, and disambiguates a lone ESC
 * with a short internal timeout, so give state a beat to settle before asserting.
 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

// Raw terminal byte sequences for the keys the typeahead listens for. Built from
// char codes so the source stays free of invisible control characters.
const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;

describe("humanizeTokens", () => {
  it("formats token counts compactly", () => {
    expect(humanizeTokens(0)).toBe("0");
    expect(humanizeTokens(980)).toBe("980");
    expect(humanizeTokens(1234)).toBe("1.2k");
    expect(humanizeTokens(23000)).toBe("23k");
  });
});

describe("StatusLine (model, tokens, cache, cost)", () => {
  it("renders model, branch, tokens, cache hit/miss and cost", () => {
    // Compact inputs keep the single line within the 80-col test terminal so
    // substrings aren't split by wrapping (real terminals are wider).
    const { lastFrame } = render(
      <StatusLine
        model="x/sonnet"
        branch="main"
        inputTokens={1234}
        outputTokens={5678}
        cacheHit={87_100_000}
        cacheMiss={1_000_000}
        costUsd={58.74}
        mode="ask"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("sonnet");
    expect(frame).toContain("main");
    expect(frame).toContain("↑1.2k");
    expect(frame).toContain("↓5.7k");
    expect(frame).toContain("87.1Mhit");
    expect(frame).toContain("1.0Mmiss");
    expect(frame).toContain("~$58.74");
  });

  it("omits the branch chip when no branch is provided", () => {
    const { lastFrame } = render(
      <StatusLine
        model="x/y"
        inputTokens={0}
        outputTokens={0}
        cacheHit={0}
        cacheMiss={0}
        costUsd={0}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("│  ‌"); // no dangling branch separator
  });
});

describe("StatusLine (pipeline indicator)", () => {
  const base = {
    model: "x/y",
    inputTokens: 0,
    outputTokens: 0,
    cacheHit: 0,
    cacheMiss: 0,
    costUsd: 0,
  } as const;

  it("shows the dumbbell + 'pipeline activated' when pipelineOn is true", () => {
    const { lastFrame } = render(<StatusLine {...base} pipelineOn={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("🏋️");
    expect(frame).toContain("pipeline activated");
    expect(frame).not.toContain("bare");
  });

  it("shows 'bare' in red when pipelineOn is false", () => {
    const { lastFrame } = render(<StatusLine {...base} pipelineOn={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bare");
    expect(frame).not.toContain("pipeline activated");
  });

  it("shows neither indicator when pipelineOn is undefined", () => {
    const { lastFrame } = render(<StatusLine {...base} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("pipeline activated");
    expect(frame).not.toContain("bare");
  });
});

describe("StatusLine (permission line)", () => {
  it.each([
    ["bypass", "bypass permissions on"],
    ["acceptEdits", "auto-accept edits on"],
    ["readonly", "read-only"],
    ["ask", "ask before edits"],
  ] as const)("shows the %s permission line", (mode, label) => {
    const { lastFrame } = render(
      <StatusLine
        model="x/y"
        inputTokens={0}
        outputTokens={0}
        cacheHit={0}
        cacheMiss={0}
        costUsd={0}
        mode={mode}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(label);
    expect(frame).toContain("shift+tab to cycle");
  });
});

describe("PromptInput typeahead", () => {
  const catalog: SlashCatalogEntry[] = [
    {
      name: "help",
      description: "Show the slash-command help",
      source: "builtin",
      productized: true,
    },
    {
      name: "pipeline",
      description: "Toggle prompt evaluation and completeness judging",
      argumentHint: "[on|off]",
      source: "builtin",
      productized: true,
    },
    {
      name: "model",
      description: "Show or set the gateway model",
      argumentHint: "[slug]",
      source: "builtin",
      productized: true,
    },
    {
      name: "mode",
      description: "Show or set the permission posture",
      argumentHint: "[ask]",
      source: "builtin",
      productized: true,
    },
    {
      name: "cost",
      description: "Project model cost",
      source: "cli",
      productized: true,
    },
  ];

  it("stays closed until a slash command is being typed", () => {
    const { lastFrame } = render(
      <PromptInput onSubmit={() => {}} busy={false} catalog={catalog} />,
    );
    expect(lastFrame() ?? "").not.toContain("navigate");
  });

  it("opens the menu and filters as the user types", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PromptInput onSubmit={() => {}} busy={false} catalog={catalog} />,
    );
    stdin.write("/pi");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/pipeline");
    expect(frame).toContain("Toggle prompt evaluation");
    expect(frame).toContain("[on|off]");
    expect(frame).not.toContain("/cost"); // filtered out
    unmount();
  });

  it("denotes productized commands with color, not a glyph, in the menu", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PromptInput onSubmit={() => {}} busy={false} catalog={catalog} />,
    );
    stdin.write("/h");
    await tick();
    const frame = lastFrame() ?? "";
    // The redesign replaced the 📦 glyph with per-command color (see slash-menu.tsx):
    // the command still renders, but the icon is gone — color now marks productized.
    expect(frame).toContain("/help");
    expect(frame).not.toContain("📦");
    unmount();
  });

  it("submits a fully-typed argument-free command on Enter", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        catalog={catalog}
      />,
    );
    stdin.write("/help");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["/help"]);
    unmount();
  });

  it("Tab completes the highlighted command and closes the menu for arg commands", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PromptInput onSubmit={() => {}} busy={false} catalog={catalog} />,
    );
    stdin.write("/mod");
    await tick();
    expect(lastFrame() ?? "").toContain("navigate"); // menu open
    stdin.write("\t");
    await tick();
    // Completed to "/mode " (an arg command): the menu closed once a space was added.
    expect(lastFrame() ?? "").not.toContain("navigate");
    unmount();
  });

  it("navigates the menu with the down arrow", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PromptInput onSubmit={() => {}} busy={false} catalog={catalog} />,
    );
    // Two matches for "m": /model (hint [slug]) then /mode (hint [ask]); the
    // unique hints disambiguate the rows (/mode is a substring of /model).
    stdin.write("/m");
    await tick();
    const before = (lastFrame() ?? "").split("\n");
    expect(before.find((l) => l.includes("[slug]")) ?? "").toContain("❯");

    stdin.write(ARROW_DOWN);
    await tick();
    const after = (lastFrame() ?? "").split("\n");
    // The pointer moved to the second match.
    expect(after.find((l) => l.includes("[ask]")) ?? "").toContain("❯");
    expect(after.find((l) => l.includes("[slug]")) ?? "").not.toContain("❯");
    unmount();
  });

  it("dismisses the menu on Escape", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PromptInput onSubmit={() => {}} busy={false} catalog={catalog} />,
    );
    stdin.write("/");
    await tick();
    expect(lastFrame() ?? "").toContain("navigate");
    stdin.write(ESC);
    await tick();
    expect(lastFrame() ?? "").not.toContain("navigate");
    unmount();
  });
});

describe("PromptInput focus + injection", () => {
  it("shows the block cursor while focused and drops it when the panel owns focus", () => {
    const focused = render(
      <PromptInput onSubmit={() => {}} busy={false} focused />,
    );
    expect(focused.lastFrame() ?? "").toContain("█");
    focused.unmount();

    const blurred = render(
      <PromptInput onSubmit={() => {}} busy={false} focused={false} />,
    );
    expect(blurred.lastFrame() ?? "").not.toContain("█");
    blurred.unmount();
  });

  it("ignores keystrokes while not focused (the panel handler owns them)", async () => {
    const calls: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        focused={false}
      />,
    );
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick();
    // Nothing typed reached the buffer, and Enter submitted nothing.
    expect(lastFrame() ?? "").not.toContain("hello");
    expect(calls).toEqual([]);
    unmount();
  });

  it("replaces the buffer when the parent bumps the injection nonce", async () => {
    const { lastFrame, rerender, unmount } = render(
      <PromptInput
        onSubmit={() => {}}
        busy={false}
        inject={{ text: "", nonce: 0 }}
      />,
    );
    await tick();
    rerender(
      <PromptInput
        onSubmit={() => {}}
        busy={false}
        inject={{ text: "recall these prompts", nonce: 1 }}
      />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("recall these prompts");
    unmount();
  });

  it("reports menu open/close to the parent via onMenuOpenChange", async () => {
    const states: boolean[] = [];
    const catalog = [
      {
        name: "help",
        description: "help",
        source: "builtin" as const,
        productized: true,
      },
    ];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={() => {}}
        busy={false}
        catalog={catalog}
        onMenuOpenChange={(open) => states.push(open)}
      />,
    );
    await tick();
    stdin.write("/h"); // opens the menu
    await tick();
    stdin.write(ESC); // dismisses it
    await tick();
    expect(states).toContain(true);
    expect(states).toContain(false);
    unmount();
  });
});

describe("modeLabel", () => {
  it("maps modes to friendly labels", () => {
    expect(modeLabel("acceptEdits")).toBe("auto-edit");
    expect(modeLabel("readonly")).toBe("read-only");
    expect(modeLabel("ask")).toBe("ask");
    expect(modeLabel("bypass")).toBe("bypass");
  });
});

describe("ApprovalPrompt", () => {
  it("renders the call summary and the reason it is asking", () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt req={sampleReq} onResolve={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run: rm -rf build");
    expect(frame).toContain("dangerous");
    expect(frame).toContain("allow once");
    unmount();
  });

  it("resolves allow on 'y', allow+remember on 'a', deny on 'n'", async () => {
    for (const [key, expected] of [
      ["y", { decision: "allow" }],
      ["a", { decision: "allow", remember: true }],
      ["n", { decision: "deny" }],
    ] as Array<[string, ApprovalResponse]>) {
      const calls: ApprovalResponse[] = [];
      const { stdin, unmount } = render(
        <ApprovalPrompt req={sampleReq} onResolve={(r) => calls.push(r)} />,
      );
      stdin.write(key);
      await tick();
      expect(calls).toEqual([expected]);
      unmount();
    }
  });
});

describe("MessageView", () => {
  const msg = (m: Partial<Message>): Message => ({
    role: "assistant",
    content: "",
    timestamp: 0,
    ...m,
  });

  it("renders a tool call as an [emoji Tool] chip with the arg (no bolt gutter)", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({
          role: "tool",
          toolName: "Bash",
          content: "git push origin main",
        })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("⚡");
    expect(frame).toContain("[💻 Bash]");
    expect(frame).toContain("git push origin main");
  });

  it("renders unmapped tools as a bare [name] chip — no wrench, no stray space", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({ role: "tool", toolName: "totally.unknown", content: "arg" })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[totally.unknown]");
    expect(frame).not.toContain("🔧");
    expect(frame).not.toContain("[ ");
  });

  it("keeps dotted capability tool names verbatim in the chip", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({
          role: "tool",
          toolName: "knowledge.query",
          content: "who owns billing",
        })}
      />,
    );
    expect(lastFrame() ?? "").toContain("[🔍 knowledge.query]");
  });

  it("renders a subagent dispatch as a Task chip", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({
          role: "tool",
          toolName: "dispatch_subagent",
          content: "break-fix → fix the failing test",
        })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[🚀 Task]");
    expect(frame).toContain("break-fix → fix the failing test");
  });

  it("gutters assistant prose with the ◆ Oxagen marker", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({ role: "assistant", content: "Found and fixed the spot." })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◆");
    expect(frame).toContain("Found and fixed the spot.");
  });

  it("renders committed assistant prose as markdown (markers consumed)", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({
          role: "assistant",
          content: "use **exact** pins and `pnpm i`",
        })}
      />,
    );
    const frame = (lastFrame() ?? "").replace(/\u001b\[[0-9;]*m/g, "");
    expect(frame).toContain("◆");
    expect(frame).toContain("exact");
    expect(frame).toContain("pnpm i");
    // Markdown is rendered, not echoed: emphasis/backtick markers are consumed.
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("`");
  });

  it("keeps streaming assistant prose as raw text with the cursor", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({
          role: "assistant",
          content: "half a **sentence",
          streaming: true,
        })}
      />,
    );
    const frame = lastFrame() ?? "";
    // Raw while streaming — unclosed markdown must not be parsed mid-stream.
    expect(frame).toContain("**sentence");
    expect(frame).toContain("▊");
  });

  it("labels reasoning as thinking", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({ role: "reasoning", content: "weighing two approaches" })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("💭 thinking");
    expect(frame).toContain("weighing two approaches");
  });

  // ── Memoization (perf regression guard) ──
  // MessageView is wrapped in React.memo so the transcript's hot re-render path
  // (fullscreen TranscriptViewport maps every visible row each streamed frame)
  // skips rows whose msg object is unchanged. These lock that in.

  it("is a React.memo component (unchanged rows can bail out of re-render)", () => {
    expect((MessageView as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  it("uses the default shallow prop comparison (no custom compare that could defeat it)", () => {
    // A null/undefined `compare` means React.memo bails whenever every prop is
    // referentially equal — exactly the "unchanged msg object" case.
    expect(
      (MessageView as unknown as { compare?: unknown }).compare ?? null,
    ).toBeNull();
  });

  // Count the memoized component's ACTUAL renders by spying on the inner render
  // function (React.memo's `.type`), which React skips calling when it bails.
  // Profiler is unusable here: its onRender fires per container commit even when
  // the memoized child bails, so it can't isolate the child's own renders.
  type MemoHandle = { type: (props: { msg: Message }) => React.ReactElement };

  it("does not re-render a row whose msg object is unchanged when its parent re-renders", () => {
    const handle = MessageView as unknown as MemoHandle;
    const original = handle.type;
    const spy = vi.fn(original);
    handle.type = spy;
    try {
      const stable = msg({
        role: "assistant",
        content: "an unchanged committed row",
      });
      function Harness({ tick }: { tick: number }): React.ReactElement {
        return (
          <Box flexDirection="column">
            <MessageView msg={stable} />
            {/* An unrelated sibling that changes, forcing the harness to
                re-render without touching MessageView's props. */}
            <Text>tick {tick}</Text>
          </Box>
        );
      }
      const { rerender } = render(<Harness tick={0} />);
      const afterMount = spy.mock.calls.length;
      expect(afterMount).toBeGreaterThan(0); // it did render on mount
      rerender(<Harness tick={1} />);
      // Same msg identity → React.memo bails → the inner render is NOT called.
      expect(spy.mock.calls.length).toBe(afterMount);
    } finally {
      handle.type = original;
    }
  });

  it("does re-render the row when the msg object identity changes", () => {
    const handle = MessageView as unknown as MemoHandle;
    const original = handle.type;
    const spy = vi.fn(original);
    handle.type = spy;
    try {
      function Harness({ m }: { m: Message }): React.ReactElement {
        return <MessageView msg={m} />;
      }
      const { rerender } = render(<Harness m={msg({ content: "first" })} />);
      const afterMount = spy.mock.calls.length;
      rerender(<Harness m={msg({ content: "second" })} />);
      // A fresh msg object (as the live streaming row produces each token) is
      // not shallow-equal, so the inner render runs again.
      expect(spy.mock.calls.length).toBeGreaterThan(afterMount);
    } finally {
      handle.type = original;
    }
  });
});

describe("StageBadge", () => {
  it("renders the pipeline stage as a bracketed chip with its label", () => {
    const { lastFrame } = render(
      <StageBadge
        stage={{
          kind: "judge",
          label: "reviewing completeness",
          detail: "advisor",
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    // The judge stage reads as "Review" in the chip.
    expect(frame).toContain("[Review]");
    expect(frame).toContain("reviewing completeness");
    expect(frame).toContain("advisor");
  });
});

describe("StageKind render maps (exhaustiveness)", () => {
  it("STAGE_GLYPH/STAGE_COLOR/STAGE_LABEL have an entry for every known stage", () => {
    for (const kind of KNOWN_STAGE_KINDS) {
      expect(STAGE_GLYPH[kind]).toBeTruthy();
      expect(STAGE_COLOR[kind]).toBeTruthy();
      expect(STAGE_LABEL[kind]).toBeTruthy();
    }
  });

  it("expose exactly the known stage kinds — no stragglers, none missing", () => {
    expect(Object.keys(STAGE_GLYPH).sort()).toEqual(
      [...KNOWN_STAGE_KINDS].sort(),
    );
    expect(Object.keys(STAGE_COLOR).sort()).toEqual(
      [...KNOWN_STAGE_KINDS].sort(),
    );
    expect(Object.keys(STAGE_LABEL).sort()).toEqual(
      [...KNOWN_STAGE_KINDS].sort(),
    );
  });

  it("StageBadge renders every known stage without falling through to undefined", () => {
    for (const kind of KNOWN_STAGE_KINDS) {
      const { lastFrame } = render(
        <StageBadge stage={{ kind, label: `${kind} stage` }} />,
      );
      const frame = lastFrame() ?? "";
      expect(frame).toContain(`[${STAGE_LABEL[kind]}]`);
      expect(frame).not.toContain("undefined");
    }
  });
});

describe("TurnSummaryView", () => {
  it("shows completeness, quality score, files and cost when judged", () => {
    const { lastFrame } = render(
      <TurnSummaryView
        summary={{
          complete: true,
          quality: 94,
          filesTouched: ["interactive.tsx", "components.tsx"],
          costUsd: 0.03,
          judged: true,
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓ complete");
    expect(frame).toContain("quality");
    expect(frame).toContain("94/100");
    expect(frame).toContain("interactive.tsx (+1)");
    expect(frame).toContain("cost");
  });

  it("shows the judge's reason for the score when judged", () => {
    const { lastFrame } = render(
      <TurnSummaryView
        summary={{
          complete: true,
          quality: 88,
          qualityReason:
            "All requested edits landed and the tests cover the new branch.",
          filesTouched: [],
          costUsd: 0.01,
          judged: true,
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("88/100");
    expect(frame).toContain("reason");
    expect(frame).toContain("All requested edits landed");
  });

  it("truncates an over-long reason so the card stays compact", () => {
    const { lastFrame } = render(
      <TurnSummaryView
        summary={{
          complete: false,
          quality: 40,
          qualityReason: "gap ".repeat(200),
          filesTouched: [],
          costUsd: 0,
          judged: true,
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("…");
  });

  it("marks gaps and omits the quality score in bare mode", () => {
    const { lastFrame } = render(
      <TurnSummaryView
        summary={{
          complete: false,
          filesTouched: [],
          costUsd: 0,
          judged: false,
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚠ gaps remain");
    expect(frame).toContain("not judged (bare mode)");
    expect(frame).not.toContain("/100");
    expect(frame).toContain("none");
  });
});

describe("ThinkingIndicator", () => {
  it("shows the thinking label, elapsed seconds, and live token estimate", () => {
    const { lastFrame, unmount } = render(
      <ThinkingIndicator startedAt={Date.now() - 3000} getTokens={() => 800} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking…");
    expect(frame).toMatch(/\d+s/);
    expect(frame).toContain("800 tok");
    unmount();
  });
});

describe("renderInvadersLane", () => {
  const W = 24;

  it("stands down when idle: rocket parked at the left, UFO calm at the far end", () => {
    const lane = renderInvadersLane(0, W, false);
    expect(lane).toHaveLength(W); // fixed width — no layout jitter frame to frame
    expect(lane.startsWith("|=>")).toBe(true); // powered-down rocket, thrust off
    expect(lane.trimEnd().endsWith("<●>")).toBe(true); // UFO holding position
    expect(lane).not.toContain("•"); // no bolt in flight while still
  });

  it("fires when active: the bolt streaks out ahead of the rocket toward the UFO", () => {
    // Tick 2 is mid-flight (well before the tick-6 hit for this width), so
    // rocket, bolt, and UFO are all on the lane at once.
    const lane = renderInvadersLane(2, W, true);
    expect(lane).toHaveLength(W);
    expect(lane).toMatch(/^[{}-]=>/); // a rocket frame (idle flicker or recoil) at the nose
    const noseIdx = lane.indexOf(">"); // always index 2 — first char after the rocket sprite
    const boltIdx = lane.indexOf("•");
    const ufoIdx = lane.search(/<[●○]>/);
    expect(boltIdx).toBeGreaterThan(noseIdx);
    expect(ufoIdx).toBeGreaterThan(boltIdx); // the UFO is still further out ahead of the bolt
  });

  it("advances the bolt frame over frame as it streaks across the lane", () => {
    const boltAt = (tick: number): number =>
      renderInvadersLane(tick, W, true).indexOf("•");
    // Ticks 0-2 are the opening flight of the first volley at this width —
    // the bolt moves BOLT_SPEED (3) cells closer to the UFO each tick.
    expect(boltAt(0)).toBe(3);
    expect(boltAt(1)).toBe(6);
    expect(boltAt(2)).toBe(9);
  });

  it("blooms into a brief explosion on a hit, then reforms the UFO", () => {
    // Verified fixture: at W=24 the first volley's bolt connects on tick 6.
    const impact = renderInvadersLane(6, W, true);
    expect(impact).toMatch(/[✳✸]/);
    expect(impact).not.toContain("•"); // the bolt is spent on impact
    expect(impact.search(/<[●○]>/)).toBe(-1); // the explosion replaces the UFO glyph
    const dissipating = renderInvadersLane(7, W, true);
    expect(dissipating).toMatch(/[✳✸]/);
    // Later in the same beat (before the next volley reloads) the UFO reforms.
    const reformed = renderInvadersLane(8, W, true);
    expect(reformed).toMatch(/<[●○]>/);
    expect(reformed).not.toMatch(/[✳✸]/);
  });

  it("occasionally lets the UFO's weave carry it clear of the bolt for a near-miss", () => {
    // Verified fixture: at W=24 (fire cycle 9, weave period 10 — coprime, so
    // the phase drifts volley to volley) the 9th volley (ticks 72-80) never
    // lines up — the bolt streaks past and the UFO is never touched.
    const frames = Array.from({ length: 9 }, (_, i) =>
      renderInvadersLane(72 + i, W, true),
    );
    expect(frames.some((f) => /[✳✸]/.test(f))).toBe(false);
    expect(frames.some((f) => f.includes("•"))).toBe(true); // the rocket still fired
    expect(frames.every((f) => /<[●○]>/.test(f))).toBe(true); // the UFO is untouched throughout
  });

  it("is deterministic: the same tick always renders the same frame", () => {
    expect(renderInvadersLane(5, W, true)).toBe(renderInvadersLane(5, W, true));
    expect(renderInvadersLane(37, W, true)).toBe(
      renderInvadersLane(37, W, true),
    );
    // Adjacent ticks differ — the scene actually moves.
    expect(renderInvadersLane(1, W, true)).not.toBe(
      renderInvadersLane(2, W, true),
    );
  });

  it("loops cleanly: the rocket-fire cadence and UFO weave realign after one full beat", () => {
    // lcm(fire cycle 9, weave period 10) = 90 for this width.
    for (const t of [0, 1, 6, 7, 15, 37]) {
      expect(renderInvadersLane(t, W, true)).toBe(
        renderInvadersLane(t + 90, W, true),
      );
    }
  });

  it("clamps width into a sane range so a tiny or huge terminal still renders", () => {
    expect(renderInvadersLane(0, 2, true)).toHaveLength(14); // floor
    expect(renderInvadersLane(0, 999, true)).toHaveLength(30); // ceiling
  });
});

describe("SpaceInvaders", () => {
  it("shows the parked rocket and standby marker when idle", () => {
    const { lastFrame, unmount } = render(<SpaceInvaders active={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("|=>"); // powered down
    expect(frame).toContain("·"); // standby marker
    unmount();
  });

  it("renders the firing rocket with the active marker while active", () => {
    const { lastFrame, unmount } = render(<SpaceInvaders active={true} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▸"); // active marker
    expect(frame).toMatch(/[{}-]=>/); // a rocket frame is on the lane
    unmount();
  });
});
