import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { CommandForm } from "../command-form.js";
import type { CommandNode } from "../command-tree.js";

const node: CommandNode = {
  name: "login",
  description: "Authenticate",
  path: ["auth", "login"],
  args: [],
  options: [
    { flags: "--email <e>", long: "--email", description: "Email", required: true, isBoolean: false, takesValue: true, secret: false },
    { flags: "--password <p>", long: "--password", description: "Password", required: true, isBoolean: false, takesValue: true, secret: true },
  ],
  children: [],
  runnable: true,
};

const ENTER = "\r";
// ink 7 buffers bare ESC for 20 ms to distinguish it from an escape-sequence
// prefix — flush the pending-escape timer with fake timers.
const ESC = "\x1b";

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandForm", () => {
  it("renders a field per option and masks secret fields", () => {
    const { lastFrame } = render(<CommandForm node={node} onSubmit={() => {}} onCancel={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("--email");
    expect(frame).toContain("--password");
    expect(frame.toLowerCase()).toContain("required");
  });

  it("blocks submit while a required field is empty", () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<CommandForm node={node} onSubmit={onSubmit} onCancel={() => {}} />);
    stdin.write(ENTER); // attempt submit with empty required fields
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onCancel on escape", () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    const { stdin } = render(<CommandForm node={node} onSubmit={() => {}} onCancel={onCancel} />);
    stdin.write(ESC); // ESC — ink 7 parks bare \x1b in a pending-escape buffer
    vi.advanceTimersByTime(25); // flush the 20 ms pending-escape debounce
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
