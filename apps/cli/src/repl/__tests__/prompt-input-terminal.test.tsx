/**
 * PromptInput terminal-emulator mode — proves that typing a leading "!" flips
 * the prompt bar into shell mode (a `$` prompt + a "terminal" hint) and that the
 * visible buffer drops the bang, so the bar reads like a real terminal.
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { PromptInput } from "../components.js";

/** Ink delivers stdin to useInput asynchronously; give state a beat to settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe("PromptInput terminal mode (!command)", () => {
  it("shows the normal ❯ prompt with no bang", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} />,
    );
    stdin.write("ls");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("❯");
    expect(frame).not.toContain("terminal · Enter runs");
  });

  it("flips to a $ shell prompt + hint the instant the buffer opens with !", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} />,
    );
    stdin.write("!pnpm build");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("$");
    expect(frame).toContain("pnpm build");
    // The leading "!" is dropped from the visible command — the $ conveys shell.
    expect(frame).not.toContain("!pnpm build");
    expect(frame).toContain("terminal · Enter runs");
  });

  it("submits the raw text including the bang so the container can route it", async () => {
    const calls: string[] = [];
    const { stdin } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("!echo hi");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["!echo hi"]);
  });
});
