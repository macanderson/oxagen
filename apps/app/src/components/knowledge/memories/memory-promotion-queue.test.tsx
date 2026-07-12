// @vitest-environment jsdom
/**
 * memory-promotion-queue.test.tsx — Promotion candidates queue for
 * Knowledge → Memory.
 *
 * Covers: the load-error state (with retry via router.refresh), the empty
 * state, candidates rendering via NodeRef (lesson, never the raw id), the
 * RULE confirm flow (rationale required), the FACT confirm flow (rationale
 * AND the explicit "I confirm…" checkbox required — the spec's
 * human-confirmation gate for FACT-type promotions), and removal from the
 * local list + router.refresh() on a successful promote.
 *
 * The Base UI Popover primitive (used by NodeRef) is mocked to flat markup,
 * same convention as the other new memory panels' tests.
 */

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

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
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { MemoryPromotionQueue, type PromotionCandidate } from "./memory-promotion-queue";

afterEach(() => {
  cleanup();
  mockRefresh.mockClear();
});

const BASE = { orgSlug: "oxagen", workspaceSlug: "main" };

function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    id: "913d6df1-5dca-4bc7-aff6-193939228260",
    publicId: "mem_pub_1",
    lesson: "Always open a PR before merging.",
    memoryKind: "constraint",
    citationCount: 5,
    influenceCount: 3,
    confidenceScore: 82,
    ...overrides,
  };
}

describe("MemoryPromotionQueue — load states", () => {
  it("shows an error state with retry when loadError is set", () => {
    const promoteMemory = vi.fn();
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[]}
        loadError="neo4j unavailable"
        promoteMemory={promoteMemory}
      />,
    );
    expect(screen.getByText("neo4j unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when there are no candidates and no error", () => {
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[]}
        loadError={null}
        promoteMemory={vi.fn()}
      />,
    );
    expect(screen.getByText("No promotion candidates")).toBeInTheDocument();
  });

  it("renders each candidate via NodeRef (lesson, not the raw id)", () => {
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        promoteMemory={vi.fn()}
      />,
    );
    // NodeRef renders the lesson in trigger + (mock-open) popover header, so
    // the label appears more than once — assert with getAllByText.
    expect(
      screen.getAllByText("Always open a PR before merging.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText("913d6df1-5dca-4bc7-aff6-193939228260"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("5 citations")).toBeInTheDocument();
  });
});

describe("MemoryPromotionQueue — RULE confirm flow", () => {
  it("requires a rationale before promoting to RULE", async () => {
    const promoteMemory = vi.fn();
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        promoteMemory={promoteMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^review promotion candidate/i }));
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm promote to rule/i }));

    expect(
      screen.getByText("Explain why this memory is ready to promote."),
    ).toBeInTheDocument();
    expect(promoteMemory).not.toHaveBeenCalled();
  });

  it("promotes to RULE with the enforcement score + rationale, then removes the row and refreshes", async () => {
    const promoteMemory = vi.fn().mockResolvedValue({ ok: true, memory: {} });
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        promoteMemory={promoteMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^review promotion candidate/i }));
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    fireEvent.change(screen.getByLabelText("Rationale"), {
      target: { value: "Cited consistently across sessions." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^confirm promote to rule/i }));

    await waitFor(() => expect(promoteMemory).toHaveBeenCalledTimes(1));
    expect(promoteMemory.mock.calls[0]?.[0]).toEqual({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "913d6df1-5dca-4bc7-aff6-193939228260",
      toClass: "RULE",
      enforcementScore: 50,
      rationale: "Cited consistently across sessions.",
    });

    await waitFor(() =>
      expect(screen.getByText("No promotion candidates")).toBeInTheDocument(),
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("MemoryPromotionQueue — FACT confirm flow (human confirmation gate)", () => {
  it("keeps the confirm button disabled until the explicit FACT acknowledgement is checked", async () => {
    const promoteMemory = vi.fn();
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        promoteMemory={promoteMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^review promotion candidate/i }));
    fireEvent.click(screen.getByRole("button", { name: "Promote to Fact" }));
    fireEvent.change(screen.getByLabelText("Rationale"), {
      target: { value: "Confirmed durable across many sessions." },
    });

    const confirmButton = screen.getByRole("button", { name: /^confirm promote to fact/i });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(confirmButton);
    expect(promoteMemory).not.toHaveBeenCalled();
  });

  it("promotes to FACT only after the acknowledgement checkbox is checked", async () => {
    const promoteMemory = vi.fn().mockResolvedValue({ ok: true, memory: {} });
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        promoteMemory={promoteMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^review promotion candidate/i }));
    fireEvent.click(screen.getByRole("button", { name: "Promote to Fact" }));
    fireEvent.change(screen.getByLabelText("Rationale"), {
      target: { value: "Confirmed durable across many sessions." },
    });
    fireEvent.click(
      screen.getByLabelText(/I confirm this is a durable, org-wide fact/i),
    );

    const confirmButton = screen.getByRole("button", { name: /^confirm promote to fact/i });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(promoteMemory).toHaveBeenCalledTimes(1));
    expect(promoteMemory.mock.calls[0]?.[0]).toEqual({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "913d6df1-5dca-4bc7-aff6-193939228260",
      toClass: "FACT",
      rationale: "Confirmed durable across many sessions.",
    });
  });

  it("shows the promote error inline and keeps the candidate in the queue on failure", async () => {
    const promoteMemory = vi.fn().mockResolvedValue({ ok: false, error: "concurrent update" });
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        promoteMemory={promoteMemory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^review promotion candidate/i }));
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "Solid signal." } });
    fireEvent.click(screen.getByRole("button", { name: /^confirm promote to rule/i }));

    await waitFor(() => expect(screen.getByText("concurrent update")).toBeInTheDocument());
    // Candidate stays in the queue — NodeRef renders its lesson in trigger +
    // (mock-open) popover header, so assert with getAllByText.
    expect(
      screen.getAllByText("Always open a PR before merging.").length,
    ).toBeGreaterThan(0);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("MemoryPromotionQueue — dismiss/cancel", () => {
  it("returns to the Review button when the target choice is dismissed", () => {
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        promoteMemory={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^review promotion candidate/i }));
    expect(screen.getByRole("button", { name: "Promote to Rule" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Promote to Rule" })).not.toBeInTheDocument();
  });

  it("cancel from the RULE/FACT form also returns to the Review button", () => {
    render(
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        promoteMemory={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^review promotion candidate/i }));
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    expect(within(document.body).getByLabelText("Rationale")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    ).toBeInTheDocument();
  });
});
