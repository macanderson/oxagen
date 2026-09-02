// @vitest-environment jsdom
/**
 * copy-button.test.tsx — behaviour tests for CopyButton + useCopyToClipboard.
 *
 * Covers: clipboard write, copied-state flip + revert, lazy value producer,
 * aria-label swap, hook contract, clipboard failure staying at rest.
 *
 * NOTE: `userEvent.setup()` installs its own `navigator.clipboard` stub, so
 * the component tests assert through `navigator.clipboard.readText()`; the
 * hook tests (no userEvent) install an explicit mock via defineProperty
 * (jsdom's `navigator.clipboard` is a read-only getter — assign won't take).
 */

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton, useCopyToClipboard } from "./copy-button";

afterEach(cleanup);

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

describe("useCopyToClipboard", () => {
  it("writes text and flips copied, then reverts after the timeout", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    mockClipboard(writeText);
    const { result } = renderHook(() => useCopyToClipboard({ timeout: 50 }));
    expect(result.current.copied).toBe(false);
    await act(async () => {
      expect(await result.current.copy("hello")).toBe(true);
    });
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result.current.copied).toBe(true);
    await waitFor(() => expect(result.current.copied).toBe(false));
  });

  it("returns false and stays at rest when the clipboard rejects", async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const { result } = renderHook(() => useCopyToClipboard());
    await act(async () => {
      expect(await result.current.copy("nope")).toBe(false);
    });
    expect(result.current.copied).toBe(false);
  });
});

describe("CopyButton", () => {
  it("copies the value and swaps the accessible name to the copied label", async () => {
    const user = userEvent.setup();
    render(
      <CopyButton value="pk_123" label="Copy key" copiedLabel="Key copied" />,
    );
    await user.click(screen.getByRole("button", { name: "Copy key" }));
    expect(await navigator.clipboard.readText()).toBe("pk_123");
    expect(
      await screen.findByRole("button", { name: "Key copied" }),
    ).toBeInTheDocument();
  });

  it("supports a lazy value producer", async () => {
    const user = userEvent.setup();
    const produce = vi.fn(() => "generated");
    render(<CopyButton value={produce} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(produce).toHaveBeenCalledOnce();
    expect(await navigator.clipboard.readText()).toBe("generated");
  });

  it("fires onCopied after a successful write", async () => {
    const user = userEvent.setup();
    const onCopied = vi.fn();
    render(<CopyButton value="x" onCopied={onCopied} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(onCopied).toHaveBeenCalledOnce());
  });

  it("does not copy when onClick prevents default", async () => {
    const user = userEvent.setup();
    const onCopied = vi.fn();
    render(
      <CopyButton
        value="x"
        onClick={(e) => e.preventDefault()}
        onCopied={onCopied}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopied).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("stays at rest when the clipboard write fails", async () => {
    const user = userEvent.setup();
    // Override userEvent's clipboard stub with a rejecting writeText — the
    // component reads navigator.clipboard at call time, so this wins.
    mockClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const onCopied = vi.fn();
    render(<CopyButton value="x" onCopied={onCopied} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopied).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});
