// @vitest-environment jsdom
/**
 * memories-client.test.tsx — render + interaction tests for MemoriesClient.
 *
 * Covers: lesson text display, kind badge, weight badge, confidence bar,
 * empty state, kind-chip filtering, confidence-slider filtering, and
 * text-search filtering over lesson/source/nodeRef.
 * Also covers: smoke-tests for the optional updateMemory/deleteMemory action
 * props that wire up the edit/delete affordances in the detail sheet.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoriesClient } from "./memories-client";

// next/navigation is not available in jsdom — stub useRouter so the component
// mounts without throwing.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const routineRecord = {
  id: "aaaa1111-0000-0000-0000-000000000001",
  publicId: "pub-aaaa1111-0000-0000-0000-000000000001",
  nodeRef: "user:mac-anderson",
  weight: "high" as const,
  kind: "routine-change",
  lesson: "Always run pnpm i --no-frozen-lockfile after adding a dep.",
  source: "agent-session-001",
  confidence: 0.9,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastReinforcedAt: null,
};

const constraintRecord = {
  id: "bbbb2222-0000-0000-0000-000000000002",
  publicId: "pub-bbbb2222-0000-0000-0000-000000000002",
  nodeRef: "workspace:default",
  weight: "critical" as const,
  kind: "constraint",
  lesson: "Never commit directly to main — always open a PR.",
  source: "agent-session-002",
  confidence: 0.75,
  createdAt: new Date(Date.now() - 7_200_000).toISOString(),
  lastReinforcedAt: new Date(Date.now() - 1_800_000).toISOString(),
};

const gotchaRecord = {
  id: "cccc3333-0000-0000-0000-000000000003",
  publicId: "pub-cccc3333-0000-0000-0000-000000000003",
  nodeRef: "tool:tsx",
  weight: "low" as const,
  kind: "gotcha",
  lesson: "tsx --env-file does NOT override a shell-exported DATABASE_URL.",
  source: "agent-session-003",
  confidence: 0.45,
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  lastReinforcedAt: null,
};

const baseProps = {
  total: 3,
  orgId: "org-1",
  workspaceId: "ws-1",
  orgSlug: "oxagen",
  workspaceSlug: "main",
};

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe("MemoriesClient — initial render", () => {
  it("renders the lesson text for each record", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Never commit directly to main — always open a PR."),
    ).toBeInTheDocument();
  });

  it("renders the kind badge for each record", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    // routine-change → "Routine Change" badge
    expect(screen.getAllByText("Routine Change").length).toBeGreaterThan(0);
    // constraint → "Constraint" badge
    expect(screen.getAllByText("Constraint").length).toBeGreaterThan(0);
  });

  it("renders the weight badge for each record", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    // routineRecord weight = "high" → "High"
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    // constraintRecord weight = "critical" → "Critical"
    expect(screen.getAllByText("Critical").length).toBeGreaterThan(0);
  });

  it("renders a confidence meter with the correct aria-valuenow", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
      />,
    );
    // routineRecord confidence = 0.9 → 90%
    const meters = screen.getAllByRole("meter");
    expect(meters.length).toBeGreaterThan(0);
    // At least one meter has aria-valuenow of 90
    const meter90 = meters.find((m) => m.getAttribute("aria-valuenow") === "90");
    expect(meter90).toBeDefined();
  });

  it("renders the confidence percentage text", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
      />,
    );
    // 0.9 → "90%"
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("renders the nodeRef for a record", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
      />,
    );
    expect(screen.getByText("user:mac-anderson")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("MemoriesClient — empty state", () => {
  it("renders the empty state when initialRecords is []", () => {
    render(
      <MemoriesClient {...baseProps} initialRecords={[]} total={0} />,
    );
    expect(screen.getByText("No memories yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Memories appear here as agents learn during this workspace/,
      ),
    ).toBeInTheDocument();
  });

  it("does not render any record rows when initialRecords is []", () => {
    render(
      <MemoriesClient {...baseProps} initialRecords={[]} total={0} />,
    );
    expect(
      screen.queryByText("Always run pnpm i"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Kind filter
// ---------------------------------------------------------------------------

describe("MemoriesClient — kind filter", () => {
  it("shows all records when no kind filter is active", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Never commit directly to main — always open a PR."),
    ).toBeInTheDocument();
  });

  it("hides records of non-selected kinds when a kind chip is clicked", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    // Click the "Constraint" kind chip to filter to constraints only
    const constraintChip = screen.getByRole("button", {
      name: /filter by constraint/i,
    });
    fireEvent.click(constraintChip);

    // constraintRecord lesson should still be visible
    expect(
      screen.getByText("Never commit directly to main — always open a PR."),
    ).toBeInTheDocument();

    // routineRecord lesson should be hidden
    expect(
      screen.queryByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).not.toBeInTheDocument();
  });

  it("shows all records again after clearing the kind filter", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    // Activate constraint filter
    const constraintChip = screen.getByRole("button", {
      name: /filter by constraint/i,
    });
    fireEvent.click(constraintChip);

    // Deactivate it (toggle off)
    fireEvent.click(constraintChip);

    // Both records visible again
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Never commit directly to main — always open a PR."),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Confidence filter
// ---------------------------------------------------------------------------

describe("MemoriesClient — confidence filter", () => {
  it("hides records below the min confidence threshold", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, gotchaRecord]}
      />,
    );
    // Set min confidence to 80 (0.8) via slider
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "80" } });

    // routineRecord confidence = 0.9 → should remain visible
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();

    // gotchaRecord confidence = 0.45 → should be hidden
    expect(
      screen.queryByText("tsx --env-file does NOT override a shell-exported DATABASE_URL."),
    ).not.toBeInTheDocument();
  });

  it("shows all records when min confidence is 0", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, gotchaRecord]}
      />,
    );
    // Default is 0, so both records visible
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("tsx --env-file does NOT override a shell-exported DATABASE_URL."),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Text search filter
// ---------------------------------------------------------------------------

describe("MemoriesClient — text search filter", () => {
  it("hides records that don't match the search query", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    const searchInput = screen.getByPlaceholderText(
      "Search lesson, source, or node ref...",
    );
    fireEvent.change(searchInput, { target: { value: "pnpm" } });

    // routineRecord lesson contains "pnpm" → visible
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();

    // constraintRecord lesson does not contain "pnpm" → hidden
    expect(
      screen.queryByText("Never commit directly to main — always open a PR."),
    ).not.toBeInTheDocument();
  });

  it("matches on source field", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    const searchInput = screen.getByPlaceholderText(
      "Search lesson, source, or node ref...",
    );
    // routineRecord source = "agent-session-001"
    fireEvent.change(searchInput, { target: { value: "agent-session-001" } });

    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Never commit directly to main — always open a PR."),
    ).not.toBeInTheDocument();
  });

  it("matches on nodeRef field", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    const searchInput = screen.getByPlaceholderText(
      "Search lesson, source, or node ref...",
    );
    // routineRecord nodeRef = "user:mac-anderson"
    fireEvent.change(searchInput, { target: { value: "mac-anderson" } });

    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Never commit directly to main — always open a PR."),
    ).not.toBeInTheDocument();
  });

  it("shows the 'no match' empty state when search yields zero results", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
      />,
    );
    const searchInput = screen.getByPlaceholderText(
      "Search lesson, source, or node ref...",
    );
    fireEvent.change(searchInput, { target: { value: "xyzxyzxyz" } });

    expect(
      screen.getByText("No memories match your filters"),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Stats row
// ---------------------------------------------------------------------------

describe("MemoriesClient — stats row", () => {
  it("counts per-kind correctly in the stats row", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord, routineRecord]}
      />,
    );
    // The stats row shows counts as numbers; we don't assert exact DOM position,
    // just that the correct counts are visible somewhere in the document.
    // routine-change count = 2, constraint count = 1
    const allText = screen.getAllByText("2");
    expect(allText.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Edit / delete action props
// ---------------------------------------------------------------------------

describe("MemoriesClient — edit/delete action prop smoke tests", () => {
  it("renders the lesson list normally when both action props are provided", () => {
    const mockUpdate = vi.fn().mockResolvedValue({
      ok: true,
      memory: routineRecord,
    });
    const mockDelete = vi.fn().mockResolvedValue({ ok: true });

    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
        updateMemory={mockUpdate}
        deleteMemory={mockDelete}
      />,
    );

    // The lesson list is unaffected by the presence of action props.
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Never commit directly to main — always open a PR."),
    ).toBeInTheDocument();
  });

  it("renders the lesson list normally when neither action prop is provided", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
      />,
    );
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
  });

  it("does not call updateMemory or deleteMemory on initial render", () => {
    const mockUpdate = vi.fn();
    const mockDelete = vi.fn();

    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        updateMemory={mockUpdate}
        deleteMemory={mockDelete}
      />,
    );

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Create memory UI
// ---------------------------------------------------------------------------

describe("MemoriesClient — create memory UI", () => {
  // A freshly-created record the mock action resolves with.
  const createdRecord = {
    id: "dddd4444-0000-0000-0000-000000000004",
    publicId: "pub-dddd4444-0000-0000-0000-000000000004",
    nodeRef: "user-memory",
    weight: "high" as const,
    kind: "constraint",
    lesson: "Echo the target DB URL before any mutation script.",
    source: "user",
    confidence: 1,
    createdAt: new Date().toISOString(),
    lastReinforcedAt: null,
  };

  it("renders the New Memory button only when createMemory is provided", () => {
    const { rerender } = render(
      <MemoriesClient {...baseProps} initialRecords={[routineRecord]} />,
    );
    expect(
      screen.queryByRole("button", { name: "New Memory" }),
    ).not.toBeInTheDocument();

    rerender(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "New Memory" }),
    ).toBeInTheDocument();
  });

  it("does not call createMemory on initial render", () => {
    const mockCreate = vi.fn();
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={mockCreate}
      />,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("opens the create sheet with lesson, kind, and weight fields", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Memory" }));

    expect(screen.getByLabelText("Lesson text")).toBeInTheDocument();
    expect(screen.getByLabelText("Memory kind")).toBeInTheDocument();
    expect(screen.getByLabelText("Memory weight")).toBeInTheDocument();
  });

  it("offers all five kinds plus Auto-detect in the kind select", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Memory" }));

    const kindSelect = screen.getByLabelText("Memory kind");
    const optionLabels = Array.from(
      kindSelect.querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(optionLabels).toEqual([
      "Auto-detect",
      "Routine Change",
      "Constraint",
      "Bug Root Cause",
      "Convention Deviation",
      "Gotcha",
    ]);
  });

  it("submits the trimmed text with the pinned kind and weight", async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValue({ ok: true, memory: createdRecord });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={mockCreate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Memory" }));

    fireEvent.change(screen.getByLabelText("Lesson text"), {
      target: { value: "  Echo the target DB URL before any mutation.  " },
    });
    fireEvent.change(screen.getByLabelText("Memory kind"), {
      target: { value: "constraint" },
    });
    fireEvent.change(screen.getByLabelText("Memory weight"), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));

    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      text: "Echo the target DB URL before any mutation.",
      kind: "constraint",
      weight: "high",
    });
  });

  it("omits kind and weight when left on Auto-detect", async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValue({ ok: true, memory: createdRecord });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={mockCreate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Memory" }));
    fireEvent.change(screen.getByLabelText("Lesson text"), {
      target: { value: "Remember this without a pinned type." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));

    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      text: "Remember this without a pinned type.",
    });
  });

  it("prepends the created memory to the list on success", async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValue({ ok: true, memory: createdRecord });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={mockCreate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Memory" }));
    fireEvent.change(screen.getByLabelText("Lesson text"), {
      target: { value: createdRecord.lesson },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));

    // The new lesson now appears in the list.
    await vi.waitFor(() =>
      expect(screen.getByText(createdRecord.lesson)).toBeInTheDocument(),
    );
  });

  it("shows an error and keeps the sheet open when create fails", async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "You must be a workspace member to add memories." });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={mockCreate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Memory" }));
    fireEvent.change(screen.getByLabelText("Lesson text"), {
      target: { value: "Some lesson" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));

    await vi.waitFor(() =>
      expect(
        screen.getByText("You must be a workspace member to add memories."),
      ).toBeInTheDocument(),
    );
    // Sheet stays open — the lesson field is still present.
    expect(screen.getByLabelText("Lesson text")).toBeInTheDocument();
  });
});
