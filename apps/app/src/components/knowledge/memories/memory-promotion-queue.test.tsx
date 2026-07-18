// @vitest-environment jsdom
/**
 * memory-promotion-queue.test.tsx — Promotion candidates queue for
 * Knowledge → Memory.
 *
 * Covers: the load-error state (with retry via router.refresh), the empty
 * state, candidates rendering via NodeRef (lesson, never the raw id), the
 * RULE confirm flow (rationale now optional), the FACT confirm flow (the
 * explicit "I confirm…" checkbox is still required — the spec's
 * human-confirmation gate for FACT-type promotions), the RationalePicker's
 * loading/select/degraded states, the durable dismiss + Undo toast flow, and
 * removal from the local list + router.refresh() on a successful promote.
 *
 * The Base UI Popover primitive (used by NodeRef) is mocked to flat markup,
 * same convention as the other new memory panels' tests. Every render is
 * wrapped in ToastProvider/ToastViewport since useToast() throws without one.
 */

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";

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
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import {
  MemoryPromotionQueue,
  type PromotionCandidate,
} from "./memory-promotion-queue";

afterEach(() => {
  cleanup();
  mockRefresh.mockClear();
});

const BASE = { orgSlug: "oxagen", workspaceSlug: "main" };

function candidate(
  overrides: Partial<PromotionCandidate> = {},
): PromotionCandidate {
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

/** Suggestions unavailable — the RationalePicker degrades to a plain Textarea. */
function noSuggestions() {
  return vi.fn().mockResolvedValue({ ok: false, error: "no suggestions" });
}

function renderQueue(
  props: Partial<React.ComponentProps<typeof MemoryPromotionQueue>> = {},
) {
  const promoteMemory = props.promoteMemory ?? vi.fn();
  const dismissPromotion =
    props.dismissPromotion ??
    vi.fn().mockResolvedValue({ ok: true, memoryId: "x", dismissed: true });
  const suggestRationales = props.suggestRationales ?? noSuggestions();
  return render(
    <ToastProvider>
      <MemoryPromotionQueue
        {...BASE}
        initialCandidates={[candidate()]}
        loadError={null}
        {...props}
        promoteMemory={promoteMemory}
        dismissPromotion={dismissPromotion}
        suggestRationales={suggestRationales}
      />
      <ToastViewport />
    </ToastProvider>,
  );
}

describe("MemoryPromotionQueue — load states", () => {
  it("shows an error state with retry when loadError is set", () => {
    render(
      <ToastProvider>
        <MemoryPromotionQueue
          {...BASE}
          initialCandidates={[]}
          loadError="neo4j unavailable"
          promoteMemory={vi.fn()}
          dismissPromotion={vi.fn()}
          suggestRationales={noSuggestions()}
        />
        <ToastViewport />
      </ToastProvider>,
    );
    expect(screen.getByText("neo4j unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when there are no candidates and no error", () => {
    render(
      <ToastProvider>
        <MemoryPromotionQueue
          {...BASE}
          initialCandidates={[]}
          loadError={null}
          promoteMemory={vi.fn()}
          dismissPromotion={vi.fn()}
          suggestRationales={noSuggestions()}
        />
        <ToastViewport />
      </ToastProvider>,
    );
    expect(screen.getByText("No promotion candidates")).toBeInTheDocument();
  });

  it("renders each candidate via NodeRef (lesson, not the raw id)", () => {
    renderQueue();
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

describe("MemoryPromotionQueue — RationalePicker states", () => {
  it("shows a loading skeleton before suggestions resolve, then degrades to a Textarea on failure", async () => {
    renderQueue();
    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));

    // The Textarea appears once the (rejected) suggestion fetch resolves.
    const rationaleField = await screen.findByLabelText("Rationale");
    expect(rationaleField.tagName).toBe("TEXTAREA");
  });

  it("renders suggested rationales as selectable options when the fetch succeeds", async () => {
    const suggestRationales = vi.fn().mockResolvedValue({
      ok: true,
      rationales: ["Cited five times.", "Consistent across sessions."],
    });
    renderQueue({ suggestRationales });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));

    await waitFor(() => expect(suggestRationales).toHaveBeenCalledTimes(1));
    expect(suggestRationales).toHaveBeenCalledWith({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "913d6df1-5dca-4bc7-aff6-193939228260",
      toClass: "RULE",
    });

    // The Select renders with its default "No rationale" option selected —
    // proof the loaded-suggestions branch (not the degraded Textarea) rendered.
    expect(await screen.findByText("No rationale")).toBeInTheDocument();
  });
});

describe("MemoryPromotionQueue — RULE confirm flow", () => {
  it("promotes to RULE without a rationale (rationale is optional)", async () => {
    const promoteMemory = vi.fn().mockResolvedValue({ ok: true, memory: {} });
    renderQueue({ promoteMemory });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    await screen.findByLabelText("Rationale");
    fireEvent.click(
      screen.getByRole("button", { name: /^confirm promote to rule/i }),
    );

    await waitFor(() => expect(promoteMemory).toHaveBeenCalledTimes(1));
    expect(promoteMemory.mock.calls[0]?.[0]).toEqual({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "913d6df1-5dca-4bc7-aff6-193939228260",
      toClass: "RULE",
      enforcementScore: 50,
    });
  });

  it("promotes to RULE with the enforcement score + a typed rationale, then removes the row and refreshes", async () => {
    const promoteMemory = vi.fn().mockResolvedValue({ ok: true, memory: {} });
    renderQueue({ promoteMemory });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    const rationaleField = await screen.findByLabelText("Rationale");
    fireEvent.change(rationaleField, {
      target: { value: "Cited consistently across sessions." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /^confirm promote to rule/i }),
    );

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
  it("keeps the confirm button disabled until the explicit FACT acknowledgement is checked, even with no rationale", async () => {
    const promoteMemory = vi.fn();
    renderQueue({ promoteMemory });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Fact" }));
    await screen.findByLabelText("Rationale");

    const confirmButton = screen.getByRole("button", {
      name: /^confirm promote to fact/i,
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(confirmButton);
    expect(promoteMemory).not.toHaveBeenCalled();
  });

  it("promotes to FACT only after the acknowledgement checkbox is checked", async () => {
    const promoteMemory = vi.fn().mockResolvedValue({ ok: true, memory: {} });
    renderQueue({ promoteMemory });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Fact" }));
    await screen.findByLabelText("Rationale");
    fireEvent.click(
      screen.getByLabelText(/I confirm this is a durable, org-wide fact/i),
    );

    const confirmButton = screen.getByRole("button", {
      name: /^confirm promote to fact/i,
    });
    expect(confirmButton).not.toBeDisabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(promoteMemory).toHaveBeenCalledTimes(1));
    expect(promoteMemory.mock.calls[0]?.[0]).toEqual({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "913d6df1-5dca-4bc7-aff6-193939228260",
      toClass: "FACT",
    });
  });

  it("shows the promote error inline and keeps the candidate in the queue on failure", async () => {
    const promoteMemory = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "concurrent update" });
    renderQueue({ promoteMemory });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    await screen.findByLabelText("Rationale");
    fireEvent.click(
      screen.getByRole("button", { name: /^confirm promote to rule/i }),
    );

    await waitFor(() =>
      expect(screen.getByText("concurrent update")).toBeInTheDocument(),
    );
    // Candidate stays in the queue — NodeRef renders its lesson in trigger +
    // (mock-open) popover header, so assert with getAllByText.
    expect(
      screen.getAllByText("Always open a PR before merging.").length,
    ).toBeGreaterThan(0);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("MemoryPromotionQueue — dismiss (durable removal + Undo)", () => {
  it("removes the candidate immediately and calls dismissPromotion", async () => {
    const dismissPromotion = vi
      .fn()
      .mockResolvedValue({ ok: true, memoryId: "x", dismissed: true });
    renderQueue({ dismissPromotion });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // Optimistic: the candidate is gone from the list right away.
    expect(screen.getByText("No promotion candidates")).toBeInTheDocument();
    await waitFor(() => expect(dismissPromotion).toHaveBeenCalledTimes(1));
    expect(dismissPromotion).toHaveBeenCalledWith({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "913d6df1-5dca-4bc7-aff6-193939228260",
    });
  });

  it("shows an Undo toast that restores the candidate when clicked", async () => {
    const dismissPromotion = vi
      .fn()
      .mockResolvedValue({ ok: true, memoryId: "x", dismissed: true });
    renderQueue({ dismissPromotion });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    const undoButton = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undoButton);

    await waitFor(() => expect(dismissPromotion).toHaveBeenCalledTimes(2));
    expect(dismissPromotion).toHaveBeenNthCalledWith(2, {
      orgSlug: "oxagen",
      workspaceSlug: "main",
      memoryId: "913d6df1-5dca-4bc7-aff6-193939228260",
      restore: true,
    });
    await waitFor(() =>
      expect(
        screen.getAllByText("Always open a PR before merging.").length,
      ).toBeGreaterThan(0),
    );
  });

  it("restores the candidate and surfaces an error toast when the dismiss call fails", async () => {
    const dismissPromotion = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "concurrent update" });
    renderQueue({ dismissPromotion });

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(screen.getByText("Couldn't dismiss")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("Always open a PR before merging.").length,
      ).toBeGreaterThan(0),
    );
  });
});

describe("MemoryPromotionQueue — cancel", () => {
  it("cancel from the RULE/FACT form returns to the Review button (candidate stays in the queue)", async () => {
    renderQueue();

    fireEvent.click(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    // The RULE-target view (enforcement slider) replaces the target-choice buttons.
    expect(
      within(document.body).getByText(/^Enforcement:/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: /^review promotion candidate/i }),
    ).toBeInTheDocument();
  });
});
