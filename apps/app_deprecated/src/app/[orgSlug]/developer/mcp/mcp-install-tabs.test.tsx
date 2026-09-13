// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { McpInstallTabs } from "./mcp-install-tabs";
import type { McpTabEntry } from "./mcp-install-tabs";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div role="tablist">{children}</div>
  ),
  TabsTab: ({
    children,
    value: _v,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <button role="tab">{children}</button>,
  TabsPanel: ({
    children,
    value: _v,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <div role="tabpanel">{children}</div>,
  TabsIndicator: () => null,
}));

vi.mock(
  "lucide-react",
  () =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : () => <svg aria-hidden="true" data-icon={String(prop)} />,
      has: (_t, prop) => prop !== "then",
    }),
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTRIES: McpTabEntry[] = [
  {
    client: "Claude Code",
    key: "claude-code",
    raw: "npx @anthropic-ai/claude-code mcp install",
    highlightedHtml:
      "<pre><code>npx @anthropic-ai/claude-code mcp install</code></pre>",
  },
  {
    client: "Cursor",
    key: "cursor",
    raw: "cursor mcp install",
    highlightedHtml: "<pre><code>cursor mcp install</code></pre>",
  },
];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpInstallTabs", () => {
  describe("empty state", () => {
    it("returns null when entries is empty", () => {
      const { container } = render(<McpInstallTabs entries={[]} />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("tab rendering", () => {
    it("renders a tab button for each entry using entry.client as text", () => {
      const { getAllByRole } = render(<McpInstallTabs entries={ENTRIES} />);
      const tabs = getAllByRole("tab");
      expect(tabs).toHaveLength(ENTRIES.length);
      expect(tabs[0]?.textContent).toBe("Claude Code");
      expect(tabs[1]?.textContent).toBe("Cursor");
    });

    it("renders one panel per entry", () => {
      const { getAllByRole } = render(<McpInstallTabs entries={ENTRIES} />);
      const panels = getAllByRole("tabpanel");
      expect(panels).toHaveLength(ENTRIES.length);
    });
  });

  describe("highlighted HTML content", () => {
    it("renders the highlighted HTML in a div with data-mcp-code attribute", () => {
      const { container } = render(<McpInstallTabs entries={ENTRIES} />);
      const codeDivs = container.querySelectorAll("[data-mcp-code]");
      expect(codeDivs).toHaveLength(ENTRIES.length);
      expect(codeDivs[0]?.innerHTML).toBe(ENTRIES[0]?.highlightedHtml);
      expect(codeDivs[1]?.innerHTML).toBe(ENTRIES[1]?.highlightedHtml);
    });
  });

  describe("CopyButton aria-label", () => {
    it("has correct initial aria-label for the first entry", () => {
      const { getAllByRole } = render(<McpInstallTabs entries={ENTRIES} />);
      const copyButtons = getAllByRole("button", {
        name: /^Copy Claude Code install command$/,
      });
      expect(copyButtons).toHaveLength(1);
    });

    it("initial aria-label follows 'Copy {client} install command' format", () => {
      const { getAllByRole } = render(<McpInstallTabs entries={ENTRIES} />);
      // One copy button per entry
      const claudeCodeBtn = getAllByRole("button", {
        name: "Copy Claude Code install command",
      });
      const cursorBtn = getAllByRole("button", {
        name: "Copy Cursor install command",
      });
      expect(claudeCodeBtn).toHaveLength(1);
      expect(cursorBtn).toHaveLength(1);
    });
  });

  describe("clipboard interaction", () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });
    });

    it("calls navigator.clipboard.writeText with entry.raw when copy button is clicked", async () => {
      const { getAllByRole } = render(<McpInstallTabs entries={ENTRIES} />);
      const copyBtn = getAllByRole("button", {
        name: "Copy Claude Code install command",
      })[0] as HTMLElement;

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(writeText).toHaveBeenCalledWith(ENTRIES[0]?.raw);
    });

    it("changes aria-label to '{client} install command copied' after click", async () => {
      const { getAllByRole, getByRole } = render(
        <McpInstallTabs entries={ENTRIES} />,
      );
      const copyBtn = getAllByRole("button", {
        name: "Copy Claude Code install command",
      })[0] as HTMLElement;

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(
        getByRole("button", { name: "Claude Code install command copied" }),
      ).toBeDefined();
    });

    it("reverts aria-label back after 2 seconds", async () => {
      vi.useFakeTimers();

      const { getAllByRole, getByRole } = render(
        <McpInstallTabs entries={ENTRIES} />,
      );
      const copyBtn = getAllByRole("button", {
        name: "Copy Claude Code install command",
      })[0] as HTMLElement;

      await act(async () => {
        fireEvent.click(copyBtn);
      });

      // Should show "copied" state. (waitFor() would deadlock here under fake
      // timers — its polling uses the faked clock — and act() above already
      // flushed the state update, so assert directly.)
      expect(
        getByRole("button", { name: "Claude Code install command copied" }),
      ).toBeDefined();

      // Advance timers past the 2-second reset
      await act(async () => {
        vi.advanceTimersByTime(2001);
      });

      expect(
        getByRole("button", { name: "Copy Claude Code install command" }),
      ).toBeDefined();

      vi.useRealTimers();
    });

    it("does not crash when clipboard.writeText rejects", async () => {
      writeText.mockRejectedValueOnce(new Error("Clipboard access denied"));

      const { getAllByRole } = render(<McpInstallTabs entries={ENTRIES} />);
      const copyBtn = getAllByRole("button", {
        name: "Copy Claude Code install command",
      })[0] as HTMLElement;

      // Should not throw
      await act(async () => {
        fireEvent.click(copyBtn);
      });

      // aria-label should remain in initial state (no setCopied(true) was called)
      expect(copyBtn.getAttribute("aria-label")).toBe(
        "Copy Claude Code install command",
      );
    });
  });
});
