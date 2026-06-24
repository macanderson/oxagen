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

// Single-field node: one optional boolean option only.
// With one field, active starts at index 0 which IS the last field
// (0 === fields.length − 1), so pressing Enter immediately calls trySubmit()
// without needing any DOWN navigation (which would require React to flush async
// state updates before the subsequent Enter write, an unsupported pattern in
// ink-testing-library v4).
const boolOnlyNode: CommandNode = {
  name: "status",
  description: "Check status",
  path: ["status"],
  args: [],
  options: [
    { flags: "--verbose", long: "--verbose", description: "Verbose output", required: false, isBoolean: true, takesValue: false, secret: false },
  ],
  children: [],
  runnable: true,
};

// Single-field node with a required text field — used by the "blocks submit"
// test. active=0 is already the last field, so Enter directly reaches the
// validation gate without any navigation that might race React's state flush.
const requiredSingleFieldNode: CommandNode = {
  name: "init",
  description: "Initialise workspace",
  path: ["init"],
  args: [],
  options: [
    { flags: "--name <n>", long: "--name", description: "Workspace name", required: true, isBoolean: false, takesValue: true, secret: false },
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
    // Secret fields must render via PasswordInput — assert the masked placeholder.
    // A regression to TextInput would omit "•••" and this assertion would catch it.
    expect(frame).toContain("•••");
  });

  it("blocks submit while a required field is empty", () => {
    const onSubmit = vi.fn();
    // requiredSingleFieldNode has exactly one field (--name, required text).
    // active=0 is already the last field, so Enter directly hits the validation
    // gate — no navigation writes that could race React's async state flush.
    const { stdin } = render(<CommandForm node={requiredSingleFieldNode} onSubmit={onSubmit} onCancel={() => {}} />);
    stdin.write(ENTER); // attempt submit with the required --name field still empty
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit with correctly-keyed FormValues when all requirements are satisfied", () => {
    const onSubmit = vi.fn();
    // boolOnlyNode has no required fields and exactly one field (--verbose,
    // boolean, default false). active=0 === fields.length-1, so Enter
    // immediately calls trySubmit() with no navigation required.
    const { stdin } = render(<CommandForm node={boolOnlyNode} onSubmit={onSubmit} onCancel={() => {}} />);
    stdin.write(ENTER); // submit from field 0 (which is also the last field)
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Boolean default must be keyed as opt:<long> with value false.
    expect(onSubmit).toHaveBeenCalledWith({ "opt:--verbose": false });
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
