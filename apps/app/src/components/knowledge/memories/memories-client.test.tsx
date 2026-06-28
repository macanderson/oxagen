// @vitest-environment jsdom
/**
 * memories-client.test.tsx — render + interaction tests for MemoriesClient.
 *
 * Covers: lesson text display, kind badge, weight badge, confidence bar,
 * empty state, kind-chip filtering, confidence-slider filtering, and
 * text-search filtering over lesson/source/nodeRef.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoriesClient } from "./memories-client";

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
