import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import {
  ApprovalPrompt,
  humanizeTokens,
  modeLabel,
  PromptInput,
  StatusLine,
  ThinkingIndicator,
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

describe("StatusLine (token counter)", () => {
  it("renders the session token counter and model", () => {
    const { lastFrame } = render(
      <StatusLine
        model="anthropic/claude-sonnet-4.5"
        readOnly={false}
        turns={2}
        inputTokens={1234}
        outputTokens={5678}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("tokens:");
    expect(frame).toContain("1.2k"); // input ↑
    expect(frame).toContain("5.7k"); // output ↓
    expect(frame).toContain("claude-sonnet-4.5");
  });

  it("shows a read-only badge when enabled", () => {
    const { lastFrame } = render(
      <StatusLine
        model="x/y"
        readOnly
        turns={0}
        inputTokens={0}
        outputTokens={0}
      />,
    );
    expect(lastFrame() ?? "").toContain("read-only");
  });
});

describe("StatusLine (permission mode)", () => {
  it("shows the mode chip when a mode is provided", () => {
    const { lastFrame } = render(
      <StatusLine
        model="x/y"
        readOnly={false}
        turns={0}
        inputTokens={0}
        outputTokens={0}
        mode="acceptEdits"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mode:");
    expect(frame).toContain("auto-edit");
  });
});

describe("StatusLine (layout chip)", () => {
  it("shows the layout chip with the active tui mode", () => {
    const { lastFrame } = render(
      <StatusLine
        model="x/y"
        readOnly={false}
        turns={0}
        inputTokens={0}
        outputTokens={0}
        tuiMode="fullscreen"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("layout:");
    expect(frame).toContain("fullscreen");
  });

  it("omits the layout chip when no tui mode is provided", () => {
    const { lastFrame } = render(
      <StatusLine model="x/y" readOnly={false} turns={0} inputTokens={0} outputTokens={0} />,
    );
    expect(lastFrame() ?? "").not.toContain("layout:");
  });
});

describe("PromptInput typeahead", () => {
  const catalog: SlashCatalogEntry[] = [
    { name: "help", description: "Show the slash-command help", source: "builtin", productized: true },
    {
      name: "tui",
      description: "Switch the terminal layout",
      argumentHint: "[compact|fullscreen]",
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
    stdin.write("/tu");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tui");
    expect(frame).toContain("Switch the terminal layout");
    expect(frame).toContain("[compact|fullscreen]");
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
