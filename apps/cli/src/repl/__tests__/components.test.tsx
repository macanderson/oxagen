import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import {
  ApprovalPrompt,
  humanizeTokens,
  modeLabel,
  MessageView,
  PromptInput,
  StatusLine,
  StageBadge,
  ThinkingIndicator,
  TurnSummaryView,
  type Message,
} from "../components.js";
import type { SlashCatalogEntry } from "../../slash/catalog.js";
import type { ApprovalRequest, ApprovalResponse } from "../../agent/permissions.js";

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
    { name: "help", description: "Show the slash-command help", source: "builtin", productized: true },
    {
      name: "pipeline",
      description: "Toggle prompt evaluation and completeness judging",
      argumentHint: "[on|off]",
      source: "builtin",
      productized: true,
    },
    { name: "model", description: "Show or set the gateway model", argumentHint: "[slug]", source: "builtin", productized: true },
    { name: "mode", description: "Show or set the permission posture", argumentHint: "[ask]", source: "builtin", productized: true },
    { name: "cost", description: "Project model cost", source: "cli", productized: true },
  ];

  it("stays closed until a slash command is being typed", () => {
    const { lastFrame } = render(<PromptInput onSubmit={() => {}} busy={false} catalog={catalog} />);
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

  it("marks productized commands with the package glyph in the menu", async () => {
    const { lastFrame, stdin, unmount } = render(
      <PromptInput onSubmit={() => {}} busy={false} catalog={catalog} />,
    );
    stdin.write("/h");
    await tick();
    expect(lastFrame() ?? "").toContain("📦");
    unmount();
  });

  it("submits a fully-typed argument-free command on Enter", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} catalog={catalog} />,
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

  it("renders a tool call as an ⚡ [emoji Tool] chip with the arg", () => {
    const { lastFrame } = render(
      <MessageView msg={msg({ role: "tool", toolName: "Bash", content: "git push origin main" })} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚡");
    expect(frame).toContain("[💻 Bash]");
    expect(frame).toContain("git push origin main");
  });

  it("keeps dotted capability tool names verbatim in the chip", () => {
    const { lastFrame } = render(
      <MessageView msg={msg({ role: "tool", toolName: "knowledge.query", content: "who owns billing" })} />,
    );
    expect(lastFrame() ?? "").toContain("[🔍 knowledge.query]");
  });

  it("renders a subagent dispatch as a Task chip", () => {
    const { lastFrame } = render(
      <MessageView
        msg={msg({
          role: "tool",
          toolName: "agent.subagent.dispatch",
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
      <MessageView msg={msg({ role: "assistant", content: "Found and fixed the spot." })} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◆");
    expect(frame).toContain("Found and fixed the spot.");
  });

  it("labels reasoning as thinking", () => {
    const { lastFrame } = render(
      <MessageView msg={msg({ role: "reasoning", content: "weighing two approaches" })} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("💭 thinking");
    expect(frame).toContain("weighing two approaches");
  });
});

describe("StageBadge", () => {
  it("renders the pipeline stage as a bracketed chip with its label", () => {
    const { lastFrame } = render(
      <StageBadge stage={{ kind: "judge", label: "reviewing completeness", detail: "advisor" }} />,
    );
    const frame = lastFrame() ?? "";
    // The judge stage reads as "Review" in the chip.
    expect(frame).toContain("[Review]");
    expect(frame).toContain("reviewing completeness");
    expect(frame).toContain("advisor");
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

  it("marks gaps and omits the quality score in bare mode", () => {
    const { lastFrame } = render(
      <TurnSummaryView
        summary={{ complete: false, filesTouched: [], costUsd: 0, judged: false }}
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
