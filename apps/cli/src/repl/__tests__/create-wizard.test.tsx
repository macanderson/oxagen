import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  CreateWizard,
  isValidName,
  type ScaffoldResult,
} from "../create-wizard.js";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const BACKSPACE = "\x7f";

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function renderWizard(
  overrides: Partial<React.ComponentProps<typeof CreateWizard>> = {},
) {
  const props: React.ComponentProps<typeof CreateWizard> = {
    kind: "command",
    onClose: () => {},
    onCreated: () => {},
    scaffold: (): ScaffoldResult => ({
      path: "/repo/.oxagen/commands/foo.md",
      created: true,
    }),
    ...overrides,
  };
  return render(<CreateWizard {...props} />);
}

describe("isValidName", () => {
  it("accepts kebab-case and rejects everything else", () => {
    expect(isValidName("code-review")).toBe(true);
    expect(isValidName("deploy")).toBe(true);
    expect(isValidName("v2")).toBe(true);
    expect(isValidName("")).toBe(false);
    expect(isValidName("Bad")).toBe(false);
    expect(isValidName("has space")).toBe(false);
    expect(isValidName("-lead")).toBe(false);
    expect(isValidName("trail-")).toBe(false);
    expect(isValidName("double--dash")).toBe(false);
  });
});

describe("CreateWizard", () => {
  it("renders the name step for the given kind", async () => {
    const { lastFrame } = renderWizard({ kind: "skill" });
    await until(() => (lastFrame() ?? "").includes("New skill"));
    expect(lastFrame()).toContain("enter to continue");
  });

  it("Esc on the name step cancels the wizard", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderWizard({ onClose });
    await until(() => (lastFrame() ?? "").includes("New slash command"));
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0);
  });

  it("rejects an invalid name with a kebab-case error and stays on the name step", async () => {
    const { lastFrame, stdin } = renderWizard();
    await until(() => (lastFrame() ?? "").includes("New slash command"));
    stdin.write("Bad"); // uppercase → invalid
    await until(() => (lastFrame() ?? "").includes("Bad")); // let the input commit first
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("use kebab-case"));
    // Editing clears the error.
    stdin.write(BACKSPACE);
    await until(() => !(lastFrame() ?? "").includes("use kebab-case"));
  });

  it("advances name → confirm → created result and fires onCreated", async () => {
    const onCreated = vi.fn();
    const scaffold = vi.fn(
      (): ScaffoldResult => ({
        path: "/repo/.oxagen/commands/deploy.md",
        created: true,
      }),
    );
    const { lastFrame, stdin } = renderWizard({ onCreated, scaffold });
    await until(() => (lastFrame() ?? "").includes("New slash command"));
    stdin.write("deploy");
    await until(() => (lastFrame() ?? "").includes("deploy")); // let the input commit first
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("Create slash command"));
    expect(stripAnsi(lastFrame()!)).toContain("deploy");
    stdin.write(ENTER); // confirm → scaffold
    await until(() => (lastFrame() ?? "").includes("✓ created"));
    expect(scaffold).toHaveBeenCalledWith("command", "deploy");
    expect(lastFrame()).toContain("/repo/.oxagen/commands/deploy.md");
    expect(onCreated).toHaveBeenCalledWith("/repo/.oxagen/commands/deploy.md");
  });

  it("Esc on the confirm step returns to the name step to rename", async () => {
    const { lastFrame, stdin } = renderWizard();
    await until(() => (lastFrame() ?? "").includes("New slash command"));
    stdin.write("foo");
    await until(() => (lastFrame() ?? "").includes("foo")); // let the input commit first
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("Create slash command"));
    stdin.write(ESC);
    await until(() => (lastFrame() ?? "").includes("enter to continue"));
  });

  it("reports an already-existing artifact without firing onCreated, and opens it with o", async () => {
    const onCreated = vi.fn();
    const openInEditor = vi.fn();
    const scaffold = (): ScaffoldResult => ({
      path: "/repo/.oxagen/commands/foo.md",
      created: false,
    });
    const { lastFrame, stdin } = renderWizard({
      onCreated,
      openInEditor,
      scaffold,
    });
    await until(() => (lastFrame() ?? "").includes("New slash command"));
    stdin.write("foo");
    await until(() => (lastFrame() ?? "").includes("foo")); // let the input commit first
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("Create slash command"));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("already exists"));
    expect(onCreated).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("press o to open it");
    stdin.write("o");
    await until(() => openInEditor.mock.calls.length > 0);
    expect(openInEditor).toHaveBeenCalledWith("/repo/.oxagen/commands/foo.md");
  });

  it("Esc on the result step closes the wizard", async () => {
    const onClose = vi.fn();
    const { lastFrame, stdin } = renderWizard({ onClose });
    await until(() => (lastFrame() ?? "").includes("New slash command"));
    stdin.write("foo");
    await until(() => (lastFrame() ?? "").includes("foo")); // let the input commit first
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("Create slash command"));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("✓ created"));
    stdin.write(ESC);
    await until(() => onClose.mock.calls.length > 0);
  });

  it("omits the open hint when no openInEditor is provided", async () => {
    const { lastFrame, stdin } = renderWizard(); // no openInEditor
    await until(() => (lastFrame() ?? "").includes("New slash command"));
    stdin.write("foo");
    await until(() => (lastFrame() ?? "").includes("foo")); // let the input commit first
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("Create slash command"));
    stdin.write(ENTER);
    await until(() => (lastFrame() ?? "").includes("✓ created"));
    const frame = stripAnsi(lastFrame()!);
    expect(frame).toContain("esc to close");
    expect(frame).not.toContain("press o");
  });
});
