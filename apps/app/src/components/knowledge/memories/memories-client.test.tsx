// @vitest-environment jsdom
/**
 * memories-client.test.tsx — render + interaction tests for MemoriesClient.
 *
 * Covers: lesson text display, kind badge, class badge, confidence meter,
 * empty state, class/kind-chip filtering, confidence-slider filtering, and
 * text-search filtering over lesson/source/nodeRef.
 * Also covers: smoke-tests for the optional updateMemory/deleteMemory/
 * promoteMemory action props that wire up the edit/delete/promote affordances
 * in the detail sheet, and the "suggested to promote" panel.
 */

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoriesClient } from "./memories-client";

// next/navigation is not available in jsdom — stub useRouter so the component
// mounts without throwing.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// MarkdownCodeEditor wraps CodeMirror, which renders a contenteditable
// `.cm-content` div (role="textbox") rather than a native <textarea>. For
// component tests we stand in a plain <textarea> so existing
// getByLabelText/fireEvent.change assertions keep working without dragging in
// CodeMirror's DOM/measurement APIs (unavailable in jsdom). Mirrors the same
// pattern used by prompt-settings-form.test.tsx.
vi.mock("@/components/ui/markdown-code-editor", () => ({
  MarkdownCodeEditor: ({
    id,
    value,
    onChange,
    disabled,
    placeholder,
    maxLength,
    ariaLabel,
  }: {
    id?: string;
    value?: string;
    onChange?: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
    maxLength?: number;
    ariaLabel?: string;
    className?: string;
    minHeight?: string;
    maxHeight?: string;
  }) => (
    <textarea
      id={id}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-label={ariaLabel}
    />
  ),
}));

// MarkdownContent (detail-sheet view mode + TruncatedText's reveal popover)
// wraps the chat MarkdownMessage renderer. Stand in a plain div so these
// tests assert on the lesson text without pulling in Streamdown/Shiki —
// mirrors the pattern used by message-bubble.test.tsx.
vi.mock("@/components/chat/markdown-message", () => ({
  MarkdownMessage: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown-message">{children}</div>
  ),
}));

// TruncatedText (list rows + detail markdown reveal) measures scroll overflow
// via ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const routineRecord = {
  id: "aaaa1111-0000-0000-0000-000000000001",
  publicId: "pub-aaaa1111-0000-0000-0000-000000000001",
  nodeRef: "user:mac-anderson",
  memoryClass: "RULE" as const,
  memoryKind: "routine-change",
  lesson: "Always run pnpm i --no-frozen-lockfile after adding a dep.",
  source: "agent-session-001",
  confidenceScore: 90,
  enforcementScore: 70,
  status: "ACTIVE" as const,
  subjectHint: "user:mac-anderson",
  halfLifeDays: 90,
  decayFloor: 5,
  lastEvidenceAt: null,
  citationCount: 0,
  influenceCount: 0,
  violationCount: 0,
  createdByKind: "AGENT" as const,
  createdById: null,
  confirmedByKind: null,
  confirmedById: null,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastReinforcedAt: null,
};

const constraintRecord = {
  id: "bbbb2222-0000-0000-0000-000000000002",
  publicId: "pub-bbbb2222-0000-0000-0000-000000000002",
  nodeRef: "workspace:default",
  memoryClass: "FACT" as const,
  memoryKind: "constraint",
  lesson: "Never commit directly to main — always open a PR.",
  source: "agent-session-002",
  confidenceScore: 75,
  enforcementScore: 100,
  status: "ACTIVE" as const,
  subjectHint: "workspace:default",
  halfLifeDays: 36500,
  decayFloor: 5,
  lastEvidenceAt: null,
  citationCount: 0,
  influenceCount: 0,
  violationCount: 0,
  createdByKind: "USER" as const,
  createdById: null,
  confirmedByKind: "USER" as const,
  confirmedById: null,
  createdAt: new Date(Date.now() - 7_200_000).toISOString(),
  lastReinforcedAt: new Date(Date.now() - 1_800_000).toISOString(),
};

const gotchaRecord = {
  id: "cccc3333-0000-0000-0000-000000000003",
  publicId: "pub-cccc3333-0000-0000-0000-000000000003",
  nodeRef: "tool:tsx",
  memoryClass: "OBSERVATION" as const,
  memoryKind: "gotcha",
  lesson: "tsx --env-file does NOT override a shell-exported DATABASE_URL.",
  source: "agent-session-003",
  confidenceScore: 45,
  enforcementScore: null,
  status: "ACTIVE" as const,
  subjectHint: "tool:tsx",
  halfLifeDays: 30,
  decayFloor: 5,
  lastEvidenceAt: null,
  citationCount: 0,
  influenceCount: 0,
  violationCount: 0,
  createdByKind: "AGENT" as const,
  createdById: null,
  confirmedByKind: null,
  confirmedById: null,
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

  it("renders the class badge for each record", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    // routineRecord class = "RULE" → "Rule"
    expect(screen.getAllByText("Rule").length).toBeGreaterThan(0);
    // constraintRecord class = "FACT" → "Fact"
    expect(screen.getAllByText("Fact").length).toBeGreaterThan(0);
  });

  it("renders a confidence meter with the correct aria-valuenow", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
      />,
    );
    // routineRecord confidenceScore = 90
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
    // confidenceScore = 90 → "90%"
    expect(screen.getAllByText("90%").length).toBeGreaterThan(0);
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

  it("hides the stats row and filter/sort controls when there are no memories", () => {
    render(<MemoriesClient {...baseProps} initialRecords={[]} total={0} />);
    // Nothing to filter yet — the control bar stays hidden so the empty state
    // sits directly under the header.
    expect(screen.queryByTestId("memory-stats-row")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search memories")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Sort memories")).not.toBeInTheDocument();
  });

  it("shows the stats row and filter controls once a memory exists", () => {
    render(<MemoriesClient {...baseProps} initialRecords={[routineRecord]} />);
    expect(screen.getByTestId("memory-stats-row")).toBeInTheDocument();
    expect(screen.getByLabelText("Search memories")).toBeInTheDocument();
    expect(screen.getByLabelText("Sort memories")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Class filter
// ---------------------------------------------------------------------------

describe("MemoriesClient — class filter", () => {
  it("shows all records when no class filter is active", () => {
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

  it("hides records of non-selected classes when a class chip is clicked", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    // Click the "Fact" class chip to filter to facts only
    const factChip = screen.getByRole("button", {
      name: /filter by fact/i,
    });
    fireEvent.click(factChip);

    // constraintRecord (FACT) lesson should still be visible
    expect(
      screen.getByText("Never commit directly to main — always open a PR."),
    ).toBeInTheDocument();

    // routineRecord (RULE) lesson should be hidden
    expect(
      screen.queryByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).not.toBeInTheDocument();
  });

  it("shows all records again after clearing the class filter", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    const factChip = screen.getByRole("button", {
      name: /filter by fact/i,
    });
    fireEvent.click(factChip);
    fireEvent.click(factChip);

    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Never commit directly to main — always open a PR."),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Kind filter
// ---------------------------------------------------------------------------

describe("MemoriesClient — kind filter", () => {
  it("hides records of non-selected kinds when a kind chip is clicked", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord, constraintRecord]}
      />,
    );
    const constraintChip = screen.getByRole("button", {
      name: /filter by constraint/i,
    });
    fireEvent.click(constraintChip);

    expect(
      screen.getByText("Never commit directly to main — always open a PR."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).not.toBeInTheDocument();
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
    // Set min confidence to 80
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "80" } });

    // routineRecord confidenceScore = 90 → should remain visible
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();

    // gotchaRecord confidenceScore = 45 → should be hidden
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
    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("tsx --env-file does NOT override a shell-exported DATABASE_URL."),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Citation filter + sort
// ---------------------------------------------------------------------------

describe("MemoriesClient — citation filter and sort", () => {
  // Two records with distinct citation counts. lowCite is newer (so it sorts
  // first by the default recency order); highCite is older but more cited.
  const lowCite = {
    ...routineRecord,
    id: "ffff6666-0000-0000-0000-000000000006",
    publicId: "pub-ffff6666-0000-0000-0000-000000000006",
    lesson: "Barely-cited lesson.",
    citationCount: 1,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
  };
  const highCite = {
    ...constraintRecord,
    id: "aaaa7777-0000-0000-0000-000000000007",
    publicId: "pub-aaaa7777-0000-0000-0000-000000000007",
    lesson: "Heavily-cited lesson.",
    citationCount: 9,
    createdAt: new Date(Date.now() - 500_000).toISOString(),
  };

  it("hides records below the min citations threshold", () => {
    render(
      <MemoriesClient {...baseProps} initialRecords={[lowCite, highCite]} />,
    );
    const minCitations = screen.getByLabelText("Minimum number of citations");
    fireEvent.change(minCitations, { target: { value: "5" } });

    expect(screen.getByText("Heavily-cited lesson.")).toBeInTheDocument();
    expect(screen.queryByText("Barely-cited lesson.")).not.toBeInTheDocument();
  });

  it("clamps a negative min citations input to zero (shows all)", () => {
    render(
      <MemoriesClient {...baseProps} initialRecords={[lowCite, highCite]} />,
    );
    const minCitations = screen.getByLabelText("Minimum number of citations");
    fireEvent.change(minCitations, { target: { value: "-3" } });

    expect(screen.getByText("Heavily-cited lesson.")).toBeInTheDocument();
    expect(screen.getByText("Barely-cited lesson.")).toBeInTheDocument();
  });

  it("reorders most-cited first when the citation sort axis is selected", () => {
    render(
      <MemoriesClient {...baseProps} initialRecords={[lowCite, highCite]} />,
    );
    // Default (recency) order: the newer lowCite renders before highCite.
    const before = screen.getByText("Barely-cited lesson.");
    const beforeHigh = screen.getByText("Heavily-cited lesson.");
    expect(
      before.compareDocumentPosition(beforeHigh) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Sort memories"), {
      target: { value: "citationCount" },
    });

    // Now the most-cited record sorts first.
    const high = screen.getByText("Heavily-cited lesson.");
    const low = screen.getByText("Barely-cited lesson.");
    expect(
      high.compareDocumentPosition(low) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("labels the list header with the active sort axis", () => {
    render(
      <MemoriesClient {...baseProps} initialRecords={[lowCite, highCite]} />,
    );
    // The label text appears both as the header <span> and as a <select>
    // <option>; assert specifically on the header span.
    const isSpan = (el: HTMLElement) => el.tagName === "SPAN";
    expect(
      screen.getAllByText("Newest first").find(isSpan),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Sort memories"), {
      target: { value: "citationCount" },
    });
    expect(screen.getAllByText("Most cited").find(isSpan)).toBeInTheDocument();
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

    expect(
      screen.getByText("Always run pnpm i --no-frozen-lockfile after adding a dep."),
    ).toBeInTheDocument();
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
  it("counts per-class correctly in the stats row", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[
          routineRecord,
          constraintRecord,
          // A second OBSERVATION with a distinct id (real Neo4j ids are unique).
          { ...routineRecord, id: `${routineRecord.id}-2`, publicId: `${routineRecord.publicId}-2` },
        ]}
      />,
    );
    // The stats row shows counts as numbers; we don't assert exact DOM position,
    // just that the correct counts are visible somewhere in the document.
    // RULE count = 2, FACT count = 1
    const statsRow = screen.getByTestId("memory-stats-row");
    expect(statsRow.textContent).toContain("Rule");
    expect(statsRow.textContent).toContain("Fact");
    expect(statsRow.textContent).toContain("Observation");
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
    ...constraintRecord,
    id: "dddd4444-0000-0000-0000-000000000004",
    publicId: "pub-dddd4444-0000-0000-0000-000000000004",
    nodeRef: "user-memory",
    lesson: "Echo the target DB URL before any mutation script.",
    source: "user",
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

  it("renders the Bulk Import button only when both parseImport and commitImport are provided", () => {
    const { rerender } = render(
      <MemoriesClient {...baseProps} initialRecords={[routineRecord]} createMemory={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: "Bulk Import" }),
    ).not.toBeInTheDocument();

    rerender(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={vi.fn()}
        parseImport={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Bulk Import" }),
    ).not.toBeInTheDocument();

    rerender(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={vi.fn()}
        parseImport={vi.fn()}
        commitImport={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Bulk Import" }),
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

  it("opens the create sheet with lesson, kind, and class fields", () => {
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
    expect(screen.getByLabelText("Memory class")).toBeInTheDocument();
  });

  it("offers Auto-detect, Observation, and Rule in the class select (no Fact)", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Memory" }));

    const classSelect = screen.getByLabelText("Memory class");
    const optionLabels = Array.from(
      classSelect.querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(optionLabels).toEqual(["Auto-detect", "Observation", "Rule"]);
  });

  it("submits the trimmed text with the pinned kind and class", async () => {
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
    fireEvent.change(screen.getByLabelText("Memory class"), {
      target: { value: "OBSERVATION" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));

    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      text: "Echo the target DB URL before any mutation.",
      memoryKind: "constraint",
      memoryClass: "OBSERVATION",
    });
  });

  it("omits kind and class when left on Auto-detect", async () => {
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

  it("shows an enforcement slider only when Rule is selected", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        createMemory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New Memory" }));
    expect(screen.queryByLabelText("Enforcement level")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Memory class"), {
      target: { value: "RULE" },
    });
    expect(screen.getByLabelText("Enforcement level")).toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// MemoryRow nested-button fix (row is role="button", not a native <button>,
// so TruncatedText's own popover-trigger button never nests inside another
// button) + detail sheet wiring through the shared markdown components.
// ---------------------------------------------------------------------------

describe("MemoriesClient — row accessibility and detail sheet", () => {
  it("renders each row as a role=button element, not a native <button>, so TruncatedText's popover trigger never nests inside another button", () => {
    render(<MemoriesClient {...baseProps} initialRecords={[routineRecord]} />);
    const row = screen
      .getByText(routineRecord.lesson)
      .closest('[role="button"]') as HTMLElement;
    expect(row.tagName).toBe("DIV");
    expect(row.querySelector("button")).toBeNull();
  });

  it("opens the detail sheet when a row is clicked", () => {
    render(
      <MemoriesClient {...baseProps} initialRecords={[routineRecord]} />,
    );
    const row = screen
      .getByText(routineRecord.lesson)
      .closest('[role="button"]') as HTMLElement;
    fireEvent.click(row);

    const markdownNodes = screen.getAllByTestId("markdown-message");
    expect(
      markdownNodes.some((n) => n.textContent === routineRecord.lesson),
    ).toBe(true);
  });

  it("opens the detail sheet when Enter is pressed on a focused row (keyboard equivalent of click)", () => {
    render(
      <MemoriesClient {...baseProps} initialRecords={[routineRecord]} />,
    );
    const row = screen
      .getByText(routineRecord.lesson)
      .closest('[role="button"]') as HTMLElement;
    fireEvent.keyDown(row, { key: "Enter" });

    const markdownNodes = screen.getAllByTestId("markdown-message");
    expect(
      markdownNodes.some((n) => n.textContent === routineRecord.lesson),
    ).toBe(true);
  });

  it("saves an edited lesson typed into the (mocked) MarkdownCodeEditor", async () => {
    const mockUpdate = vi.fn().mockResolvedValue({
      ok: true,
      memory: { ...routineRecord, lesson: "Updated lesson text." },
    });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        updateMemory={mockUpdate}
      />,
    );
    const row = screen
      .getByText(routineRecord.lesson)
      .closest('[role="button"]') as HTMLElement;
    fireEvent.click(row);

    fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));

    const lessonEditor = screen.getByLabelText("Lesson text");
    fireEvent.change(lessonEditor, {
      target: { value: "Updated lesson text." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: routineRecord.id,
        lesson: "Updated lesson text.",
      }),
    );
  });

  it("edits the kind, confidence, enforcement and source fields and saves the changes", async () => {
    const mockUpdate = vi.fn().mockResolvedValue({
      ok: true,
      memory: { ...routineRecord, memoryKind: "gotcha", enforcementScore: 30 },
    });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        updateMemory={mockUpdate}
      />,
    );
    fireEvent.click(
      screen
        .getByText(routineRecord.lesson)
        .closest('[role="button"]') as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));

    fireEvent.change(screen.getByLabelText("Memory kind"), {
      target: { value: "gotcha" },
    });
    fireEvent.change(screen.getByLabelText("Confidence level"), {
      target: { value: "42" },
    });
    // routineRecord is a RULE, so the Enforcement slider is rendered.
    fireEvent.change(screen.getByLabelText("Enforcement level"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "manual-review" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: routineRecord.id,
        memoryKind: "gotcha",
        confidenceScore: 42,
        enforcementScore: 30,
        source: "manual-review",
      }),
    );
  });

  it("cancels edit mode and returns to the read-only detail view", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        updateMemory={vi.fn()}
      />,
    );
    fireEvent.click(
      screen
        .getByText(routineRecord.lesson)
        .closest('[role="button"]') as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));
    expect(screen.getByLabelText("Lesson text")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Back in view mode: the Edit button returns and the lesson editor is gone.
    expect(
      screen.getByRole("button", { name: "Edit memory" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Lesson text")).toBeNull();
  });

  it("deletes a memory through the two-step confirm", async () => {
    const mockDelete = vi.fn().mockResolvedValue({ ok: true });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        deleteMemory={mockDelete}
      />,
    );
    fireEvent.click(
      screen
        .getByText(routineRecord.lesson)
        .closest('[role="button"]') as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete memory" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm delete memory" }),
    );

    await vi.waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: routineRecord.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

describe("MemoriesClient — promote flow", () => {
  it("does not render Promote controls when promoteMemory is absent", () => {
    render(<MemoriesClient {...baseProps} initialRecords={[gotchaRecord]} />);
    fireEvent.click(
      screen.getByText(gotchaRecord.lesson).closest('[role="button"]') as HTMLElement,
    );
    expect(screen.queryByRole("button", { name: "Promote to Rule" })).not.toBeInTheDocument();
  });

  it("offers both Rule and Fact promote targets for an OBSERVATION", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[gotchaRecord]}
        promoteMemory={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByText(gotchaRecord.lesson).closest('[role="button"]') as HTMLElement,
    );
    expect(screen.getByRole("button", { name: "Promote to Rule" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promote to Fact" })).toBeInTheDocument();
  });

  it("only offers Fact as a promote target for a RULE", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[routineRecord]}
        promoteMemory={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByText(routineRecord.lesson).closest('[role="button"]') as HTMLElement,
    );
    expect(screen.queryByRole("button", { name: "Promote to Rule" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Promote to Fact" })).toBeInTheDocument();
  });

  it("requires a rationale before confirming a promotion", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[gotchaRecord]}
        promoteMemory={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByText(gotchaRecord.lesson).closest('[role="button"]') as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    fireEvent.click(screen.getByRole("button", { name: /confirm promote to rule/i }));

    expect(
      screen.getByText("Explain why this memory is being promoted."),
    ).toBeInTheDocument();
  });

  it("calls promoteMemory with the target class, enforcement, and rationale", async () => {
    const mockPromote = vi.fn().mockResolvedValue({
      ok: true,
      memory: { ...gotchaRecord, memoryClass: "RULE", enforcementScore: 60 },
    });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[gotchaRecord]}
        promoteMemory={mockPromote}
      />,
    );
    fireEvent.click(
      screen.getByText(gotchaRecord.lesson).closest('[role="button"]') as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    fireEvent.change(screen.getByLabelText(/rationale/i), {
      target: { value: "Cited three times with consistent outcomes." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm promote to rule/i }));

    await vi.waitFor(() => expect(mockPromote).toHaveBeenCalledTimes(1));
    expect(mockPromote).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: gotchaRecord.id,
        toClass: "RULE",
        rationale: "Cited three times with consistent outcomes.",
      }),
    );
  });

  it("does not show promote controls for a FACT (top of the ladder)", () => {
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[constraintRecord]}
        promoteMemory={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByText(constraintRecord.lesson).closest('[role="button"]') as HTMLElement,
    );
    expect(
      screen.getByText(/nothing left to promote to/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Suggested to promote panel
// ---------------------------------------------------------------------------

describe("MemoriesClient — suggested to promote panel", () => {
  const candidate = {
    id: "eeee5555-0000-0000-0000-000000000005",
    publicId: "pub-eeee5555-0000-0000-0000-000000000005",
    lesson: "Always echo the target DB URL before a mutation script.",
    memoryKind: "constraint",
    citationCount: 4,
    influenceCount: 2,
    confidenceScore: 82,
  };

  it("does not render when promotionCandidates is absent", () => {
    render(<MemoriesClient {...baseProps} initialRecords={[gotchaRecord]} promoteMemory={vi.fn()} />);
    expect(screen.queryByText("Suggested to promote")).not.toBeInTheDocument();
  });

  it("renders the top candidates once fetched", async () => {
    const mockCandidates = vi.fn().mockResolvedValue({ ok: true, candidates: [candidate] });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[gotchaRecord]}
        promoteMemory={vi.fn()}
        promotionCandidates={mockCandidates}
      />,
    );
    await vi.waitFor(() => expect(mockCandidates).toHaveBeenCalledTimes(1));
    expect(mockCandidates).toHaveBeenCalledWith({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      limit: 3,
    });
    expect(await screen.findByText("Suggested to promote")).toBeInTheDocument();
    expect(
      screen.getByText("Always echo the target DB URL before a mutation script."),
    ).toBeInTheDocument();
  });

  it("promotes a candidate inline from the panel", async () => {
    const mockCandidates = vi.fn().mockResolvedValue({ ok: true, candidates: [candidate] });
    const mockPromote = vi.fn().mockResolvedValue({
      ok: true,
      memory: { ...gotchaRecord, id: candidate.id, memoryClass: "RULE" },
    });
    render(
      <MemoriesClient
        {...baseProps}
        initialRecords={[gotchaRecord]}
        promoteMemory={mockPromote}
        promotionCandidates={mockCandidates}
      />,
    );
    await screen.findByText("Suggested to promote");

    fireEvent.click(screen.getByRole("button", { name: /promote candidate/i }));
    fireEvent.click(screen.getByRole("button", { name: "Promote to Rule" }));
    fireEvent.change(screen.getByLabelText(/rationale/i), {
      target: { value: "High citation pressure." },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm promote to rule/i }));

    await vi.waitFor(() => expect(mockPromote).toHaveBeenCalledTimes(1));
    expect(mockPromote).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: candidate.id, toClass: "RULE" }),
    );
  });
});
