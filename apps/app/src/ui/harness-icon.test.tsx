// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessIcon } from "./harness-icon";

afterEach(cleanup);
describe("HarnessIcon", () => {
  it.each([
    "claude-code",
    "claude-agent-sdk",
    "claude-desktop",
    "codex",
    "cursor",
    "stella",
  ])("shows a canonical mark for %s", (harness) => {
    const { container } = render(<HarnessIcon harness={harness} />);
    expect(container.querySelector("[data-harness-mark]")).not.toBeNull();
  });
  it.each([
    "claude_code",
    "claude",
    "claude-sdk",
    "chatgpt",
    "codex-cli",
    "Claude Code",
    " codex",
    "custom",
  ])("keeps a custom name generic: %s", (harness) => {
    const { container } = render(<HarnessIcon harness={harness} />);
    expect(container.querySelector("[data-harness-mark]")).toBeNull();
  });
});
