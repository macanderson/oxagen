// @vitest-environment jsdom
// The option-card picker (ADR-198): a free option is chosen on click; a taken
// one stays visible, is announced as unavailable with its reason, opens the
// reason on hover and on focus, and is never chosen.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { ChoiceGroup } from "./choice-group";

afterEach(cleanup);

const REASON = "Claude Code already runs on Mac's laptop as mac-claude.";

function mount(onChange = vi.fn<(value: string) => void>()) {
  const view = render(
    <ChoiceGroup
      label="Harness"
      testId="harness"
      value="codex"
      onChange={onChange}
      options={[
        { value: "claude-code", label: "Claude Code", disabledReason: REASON },
        { value: "codex", label: "Codex", sub: "OpenAI" },
        { value: "cursor", label: "Cursor", disabledReason: null },
      ]}
    />,
  );
  return { ...view, onChange };
}

describe("ChoiceGroup", () => {
  it("draws every option, the chosen one checked, and passes axe", async () => {
    const { container } = mount();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("data-value"))).toEqual([
      "claude-code",
      "codex",
      "cursor",
    ]);
    expect(screen.getByRole("radio", { name: /Codex/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expectNoAxe(container);
  });

  it("chooses a free option", () => {
    const { onChange } = mount();
    fireEvent.click(screen.getByRole("radio", { name: /Cursor/ }));
    expect(onChange).toHaveBeenCalledWith("cursor");
  });

  it("keeps a taken option visible, describes it with its reason, and never chooses it", () => {
    const { onChange } = mount();
    const taken = screen.getByRole("radio", { name: /Claude Code/ });
    expect(taken).toHaveAttribute("aria-disabled", "true");
    expect(taken).toHaveAccessibleDescription(REASON);
    fireEvent.click(taken);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens the reason on hover and on focus, and closes it on leave, blur and Escape", () => {
    mount();
    const taken = screen.getByRole("radio", { name: /Claude Code/ });
    const reason = screen.getByTestId("harness-option-reason");
    expect(reason).not.toHaveAttribute("data-open");
    fireEvent.mouseEnter(taken);
    expect(reason).toHaveAttribute("data-open");
    fireEvent.mouseLeave(taken);
    expect(reason).not.toHaveAttribute("data-open");
    fireEvent.focus(taken);
    expect(reason).toHaveAttribute("data-open");
    fireEvent.keyDown(taken, { key: "Escape" });
    expect(reason).not.toHaveAttribute("data-open");
    fireEvent.focus(taken);
    fireEvent.blur(taken);
    expect(reason).not.toHaveAttribute("data-open");
  });

  it("opens no popover over a free option", () => {
    mount();
    fireEvent.mouseEnter(screen.getByRole("radio", { name: /Cursor/ }));
    expect(screen.queryAllByRole("tooltip", { hidden: true })).toHaveLength(1);
  });
});
