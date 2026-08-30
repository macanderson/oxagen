// @vitest-environment jsdom
/**
 * memory-evidence-attach-form.test.tsx — Evidence attach panel for
 * Knowledge → Memory.
 *
 * Covers: blank-memoryId validation (no server call), the happy path
 * (attachEvidence receives the trimmed memoryId/sourceKind/strength/detail/
 * refutes, and a success confirmation renders via NodeRef — never a raw
 * memoryId), optional detail omitted when blank, the refutes toggle, and the
 * error path.
 *
 * The Base UI Select/Switch/Popover primitives are mocked to flat, testable
 * markup (same convention as the citations panel test) so interaction tests
 * don't depend on floating-ui positioning in jsdom.
 */

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    children,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
  }) => (
    <button type="button" aria-label={ariaLabel}>
      {children}
    </button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const SelectContext = React.createContext<{
  onValueChange?: (v: string) => void;
}>({});

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <SelectContext.Provider value={{ onValueChange }}>
      <div data-current-value={value}>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({
    children,
    id,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    id?: string;
    "aria-label"?: string;
  }) => (
    <div id={id} aria-label={ariaLabel}>
      {children}
    </div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const { onValueChange } = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    id,
    checked,
    onCheckedChange,
    disabled,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (next: boolean) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
}));

import { MemoryEvidenceAttachForm } from "./memory-evidence-attach-form";

afterEach(cleanup);

const BASE = { orgSlug: "oxagen", workspaceSlug: "main" };

describe("MemoryEvidenceAttachForm", () => {
  it("shows a validation error and skips the server call when memory id is blank", () => {
    const attachEvidence = vi.fn();
    render(
      <MemoryEvidenceAttachForm {...BASE} attachEvidence={attachEvidence} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /attach evidence/i }));

    expect(
      screen.getByText("Enter the id of the memory to attach evidence to."),
    ).toBeInTheDocument();
    expect(attachEvidence).not.toHaveBeenCalled();
  });

  it("attaches evidence with the trimmed memory id, default source kind, and strength", async () => {
    const attachEvidence = vi
      .fn()
      .mockResolvedValue({ ok: true, evidenceId: "ev-1", confidenceScore: 68 });
    render(
      <MemoryEvidenceAttachForm {...BASE} attachEvidence={attachEvidence} />,
    );

    fireEvent.change(screen.getByLabelText("Memory ID"), {
      target: { value: "  mem-42  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /attach evidence/i }));

    await waitFor(() => expect(attachEvidence).toHaveBeenCalledTimes(1));
    expect(attachEvidence.mock.calls[0]?.[0]).toEqual({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "mem-42",
      sourceKind: "HUMAN_CONFIRM",
      strength: 0.5,
      refutes: false,
    });

    await waitFor(() =>
      expect(screen.getByText("Evidence attached")).toBeInTheDocument(),
    );
    expect(screen.getByText("now at 68% confidence")).toBeInTheDocument();
    // The memory id is cited via a CopyableId chip (the sanctioned home for a
    // bare id) — never a raw UUID rendered as a primary label.
    expect(screen.getAllByText("mem-42").length).toBeGreaterThan(0);
  });

  it("includes detail only when non-blank, and honors a non-default source kind + strength", async () => {
    const attachEvidence = vi
      .fn()
      .mockResolvedValue({ ok: true, evidenceId: "ev-2", confidenceScore: 40 });
    render(
      <MemoryEvidenceAttachForm {...BASE} attachEvidence={attachEvidence} />,
    );

    fireEvent.change(screen.getByLabelText("Memory ID"), {
      target: { value: "mem-7" },
    });
    // The mocked SelectItem's accessible name includes both the label and
    // hint spans ("Code scan" + the descriptive hint text), so match by
    // prefix rather than an exact string.
    fireEvent.click(screen.getByRole("button", { name: /^code scan/i }));
    fireEvent.change(screen.getByLabelText("Evidence strength"), {
      target: { value: "0.9" },
    });
    fireEvent.change(screen.getByLabelText("Detail (optional)"), {
      target: { value: "  Static analysis confirmed no direct pushes.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /attach evidence/i }));

    await waitFor(() => expect(attachEvidence).toHaveBeenCalledTimes(1));
    expect(attachEvidence.mock.calls[0]?.[0]).toEqual({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "mem-7",
      sourceKind: "CODE_SCAN",
      strength: 0.9,
      detail: "Static analysis confirmed no direct pushes.",
      refutes: false,
    });
  });

  it("sends refutes:true when the refutes toggle is switched on", async () => {
    const attachEvidence = vi
      .fn()
      .mockResolvedValue({ ok: true, evidenceId: "ev-3", confidenceScore: 20 });
    render(
      <MemoryEvidenceAttachForm {...BASE} attachEvidence={attachEvidence} />,
    );

    fireEvent.change(screen.getByLabelText("Memory ID"), {
      target: { value: "mem-9" },
    });
    fireEvent.click(screen.getByLabelText("This evidence refutes the memory"));
    fireEvent.click(screen.getByRole("button", { name: /attach evidence/i }));

    await waitFor(() => expect(attachEvidence).toHaveBeenCalledTimes(1));
    expect(attachEvidence.mock.calls[0]?.[0]).toMatchObject({ refutes: true });
  });

  it("shows an inline error and no success banner when the action fails", async () => {
    const attachEvidence = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "memory not found" });
    render(
      <MemoryEvidenceAttachForm {...BASE} attachEvidence={attachEvidence} />,
    );

    fireEvent.change(screen.getByLabelText("Memory ID"), {
      target: { value: "mem-missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: /attach evidence/i }));

    await waitFor(() =>
      expect(screen.getByText("memory not found")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Evidence attached")).not.toBeInTheDocument();
  });
});
