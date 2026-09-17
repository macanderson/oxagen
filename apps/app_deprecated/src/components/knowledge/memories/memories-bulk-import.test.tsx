// @vitest-environment jsdom
/**
 * memories-bulk-import.test.tsx — render + interaction tests for the bulk
 * memory-import flow (MemoriesBulkImport).
 *
 * Covers the three stages:
 *  - select: drop zone + default anchor render; Parse disabled until a file is
 *    added; adding a file via the input enables Parse; clicking Parse calls the
 *    parseImport action with the uploaded documents.
 *  - review: drafts render in the editable grid; editing a lesson/kind and
 *    deselecting a row are reflected in the commit payload; Import is disabled
 *    when nothing is selected; skipped documents are surfaced.
 *  - result: imported/failed counts render; onImported fires when ≥1 imported.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import { MemoriesBulkImport, type DraftMemory } from "./memories-bulk-import";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a File whose .text() deterministically resolves to `content`. jsdom
 * does not reliably implement Blob.text(), so we override it on the instance.
 */
function md(name: string, content: string): File {
  const file = new File([content], name, { type: "text/markdown" });
  Object.defineProperty(file, "text", {
    value: async () => content,
    configurable: true,
  });
  return file;
}

function draft(overrides: Partial<DraftMemory> = {}): DraftMemory {
  return {
    lesson: "Always open a PR — never push to main.",
    memoryClass: "RULE",
    memoryKind: "constraint",
    enforcementScore: 95,
    source: "user",
    nodeRef: "user-memory",
    sourceDocument: "rules.md",
    classified: true,
    ...overrides,
  };
}

const baseProps = {
  orgSlug: "oxagen",
  workspaceSlug: "main",
};

// ---------------------------------------------------------------------------
// Select stage
// ---------------------------------------------------------------------------

describe("MemoriesBulkImport — select stage", () => {
  it("renders the drop zone and default anchor field", () => {
    render(
      <MemoriesBulkImport
        {...baseProps}
        onClose={vi.fn()}
        onImported={vi.fn()}
        parseImport={vi.fn()}
        commitImport={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Drop markdown files here, or click to choose"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Default node ref")).toBeInTheDocument();
  });

  it("disables Parse documents until a file is selected", () => {
    render(
      <MemoriesBulkImport
        {...baseProps}
        onClose={vi.fn()}
        onImported={vi.fn()}
        parseImport={vi.fn()}
        commitImport={vi.fn()}
      />,
    );
    const parseBtn = screen.getByRole("button", { name: /parse documents/i });
    expect(parseBtn).toBeDisabled();
  });

  it("lists a selected file and enables Parse", async () => {
    render(
      <MemoriesBulkImport
        {...baseProps}
        onClose={vi.fn()}
        onImported={vi.fn()}
        parseImport={vi.fn()}
        commitImport={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Choose markdown documents");
    fireEvent.change(input, {
      target: { files: [md("rules.md", "- never push to main")] },
    });

    expect(await screen.findByText("rules.md")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /parse documents/i }),
    ).toBeEnabled();
  });

  it("rejects unsupported file extensions with a notice", async () => {
    render(
      <MemoriesBulkImport
        {...baseProps}
        onClose={vi.fn()}
        onImported={vi.fn()}
        parseImport={vi.fn()}
        commitImport={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Choose markdown documents");
    fireEvent.change(input, {
      target: { files: [md("photo.png", "binary")] },
    });
    expect(
      await screen.findByText(/Skipped 1 unsupported file/i),
    ).toBeInTheDocument();
  });

  it("calls parseImport with the uploaded documents and default anchor", async () => {
    const parseImport = vi.fn().mockResolvedValue({
      ok: true,
      drafts: [draft()],
      documentCount: 1,
      skipped: [],
    });
    render(
      <MemoriesBulkImport
        {...baseProps}
        onClose={vi.fn()}
        onImported={vi.fn()}
        parseImport={parseImport}
        commitImport={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Choose markdown documents"), {
      target: { files: [md("rules.md", "- never push to main")] },
    });
    await screen.findByText("rules.md");

    fireEvent.change(screen.getByLabelText("Default node ref"), {
      target: { value: "team:platform" },
    });
    fireEvent.click(screen.getByRole("button", { name: /parse documents/i }));

    await vi.waitFor(() => expect(parseImport).toHaveBeenCalledTimes(1));
    expect(parseImport).toHaveBeenCalledWith({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      documents: [{ filename: "rules.md", content: "- never push to main" }],
      defaultNodeRef: "team:platform",
    });
  });

  it("shows an error and stays on the select stage when parse fails", async () => {
    const parseImport = vi.fn().mockResolvedValue({
      ok: false,
      error: "You must be a workspace member to import memories.",
    });
    render(
      <MemoriesBulkImport
        {...baseProps}
        onClose={vi.fn()}
        onImported={vi.fn()}
        parseImport={parseImport}
        commitImport={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Choose markdown documents"), {
      target: { files: [md("rules.md", "- content")] },
    });
    await screen.findByText("rules.md");
    fireEvent.click(screen.getByRole("button", { name: /parse documents/i }));

    expect(
      await screen.findByText(
        "You must be a workspace member to import memories.",
      ),
    ).toBeInTheDocument();
    // Still on the select stage — the drop zone is present, the review grid is not.
    expect(
      screen.getByText("Drop markdown files here, or click to choose"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Review draft memories")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Review stage
// ---------------------------------------------------------------------------

describe("MemoriesBulkImport — review stage", () => {
  /** Drive the component to the review stage with the given parsed drafts. */
  async function toReview(
    drafts: DraftMemory[],
    skipped: { filename: string; reason: string }[] = [],
    commitImport = vi.fn(),
    onImported = vi.fn(),
  ) {
    const parseImport = vi
      .fn()
      .mockResolvedValue({ ok: true, drafts, documentCount: 1, skipped });
    render(
      <MemoriesBulkImport
        {...baseProps}
        onClose={vi.fn()}
        onImported={onImported}
        parseImport={parseImport}
        commitImport={commitImport}
      />,
    );
    fireEvent.change(screen.getByLabelText("Choose markdown documents"), {
      target: { files: [md("rules.md", "- content")] },
    });
    await screen.findByText("rules.md");
    fireEvent.click(screen.getByRole("button", { name: /parse documents/i }));
    // Wait for the review grid header to appear.
    await screen.findByText("Review draft memories");
    // The parse runs inside a useTransition; the review heading commits while
    // isPending is still true, which keeps the Import/Back buttons disabled. Wait
    // for the transition to settle (Import enabled) before returning so callers'
    // clicks are not silently swallowed by a disabled button under CI timing.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /import/i })).toBeEnabled(),
    );
    return { parseImport, commitImport, onImported };
  }

  it("renders each draft lesson in an editable field", async () => {
    await toReview([
      draft({ lesson: "Never push to main." }),
      draft({
        lesson: "Use withTenantDb, never raw db().",
        memoryKind: "gotcha",
      }),
    ]);
    expect(screen.getByDisplayValue("Never push to main.")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Use withTenantDb, never raw db()."),
    ).toBeInTheDocument();
  });

  it("surfaces skipped documents", async () => {
    await toReview(
      [draft()],
      [
        {
          filename: "toc.md",
          reason: "No durable rules found in this document.",
        },
      ],
    );
    expect(
      screen.getByText(/1 document produced no memories/i),
    ).toBeInTheDocument();
    expect(screen.getByText("toc.md")).toBeInTheDocument();
  });

  it("reflects edits + deselection in the commit payload", async () => {
    const commitImport = vi
      .fn()
      .mockResolvedValue({ ok: true, results: [], imported: 1, failed: 0 });
    await toReview(
      [
        draft({ lesson: "Keep this one.", source: "user" }),
        draft({ lesson: "Drop this one." }),
      ],
      [],
      commitImport,
    );

    // Edit the first draft's lesson + source, change its kind.
    fireEvent.change(screen.getByLabelText("Lesson for draft 1"), {
      target: { value: "Keep this one, edited." },
    });
    fireEvent.change(screen.getByLabelText("Source for draft 1"), {
      target: { value: "imported-rules" },
    });
    fireEvent.change(screen.getByLabelText("Kind for draft 1"), {
      target: { value: "routine-change" },
    });

    // Deselect the second draft.
    fireEvent.click(screen.getByLabelText("Include draft 2"));

    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /import 1 memory/i }));

    await vi.waitFor(() => expect(commitImport).toHaveBeenCalledTimes(1));
    const payload = commitImport.mock.calls[0]?.[0] as {
      orgSlug: string;
      drafts: Array<DraftMemory>;
    };
    expect(payload.orgSlug).toBe("oxagen");
    expect(payload.drafts).toHaveLength(1);
    expect(payload.drafts[0]).toMatchObject({
      lesson: "Keep this one, edited.",
      source: "imported-rules",
      memoryKind: "routine-change",
      // editing kind marks it as user-supplied, not auto-classified
      classified: false,
    });
    // The deselected draft must not be sent, and no `include` flag leaks through.
    expect(payload.drafts[0]).not.toHaveProperty("include");
  });

  it("disables Import when no rows are selected", async () => {
    await toReview([draft()]);
    // Deselect the only row.
    fireEvent.click(screen.getByLabelText("Include draft 1"));
    expect(screen.getByText("0 of 1 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /import 0 memor/i }),
    ).toBeDisabled();
  });

  it("select-all toggles every row", async () => {
    await toReview([draft(), draft({ lesson: "Second." })]);
    // Deselect all via select-all (currently all selected).
    fireEvent.click(screen.getByLabelText("Select all drafts"));
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
    // Re-select all.
    fireEvent.click(screen.getByLabelText("Select all drafts"));
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
  });

  it("shows an error and stays on review when commit fails outright", async () => {
    const commitImport = vi.fn().mockResolvedValue({
      ok: false,
      error: "You must be a workspace member to import memories.",
    });
    await toReview([draft({ lesson: "Keep." })], [], commitImport);

    // findByRole (not getByRole): the review heading and the include-flagged
    // drafts can land in separate renders, so the Import button's count settles
    // a tick after the heading appears. Wait for the correctly-labelled button.
    fireEvent.click(
      await screen.findByRole("button", { name: /import 1 memory/i }),
    );

    expect(
      await screen.findByText(
        "You must be a workspace member to import memories.",
      ),
    ).toBeInTheDocument();
    // Still on review (the grid + Import button remain), not the result stage.
    expect(screen.getByText("Review draft memories")).toBeInTheDocument();
    expect(screen.queryByText("Import complete")).not.toBeInTheDocument();
  });

  it("returns to the select stage when Back is clicked", async () => {
    await toReview([draft()]);
    fireEvent.click(await screen.findByRole("button", { name: /back/i }));
    // findBy (not getBy): the select stage repaints after the click, so wait for
    // the drop zone rather than asserting synchronously (flaky under load).
    expect(
      await screen.findByText("Drop markdown files here, or click to choose"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Review draft memories")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Result stage
// ---------------------------------------------------------------------------

describe("MemoriesBulkImport — result stage", () => {
  async function importDrafts(commitResult: {
    ok: true;
    results: {
      lesson: string;
      ok: boolean;
      memoryId: string | null;
      error: string | null;
    }[];
    imported: number;
    failed: number;
  }) {
    const commitImport = vi.fn().mockResolvedValue(commitResult);
    const onImported = vi.fn();
    const parseImport = vi.fn().mockResolvedValue({
      ok: true,
      drafts: [draft({ lesson: "Lesson A." }), draft({ lesson: "Lesson B." })],
      documentCount: 1,
      skipped: [],
    });
    render(
      <MemoriesBulkImport
        {...baseProps}
        onClose={vi.fn()}
        onImported={onImported}
        parseImport={parseImport}
        commitImport={commitImport}
      />,
    );
    fireEvent.change(screen.getByLabelText("Choose markdown documents"), {
      target: { files: [md("rules.md", "- content")] },
    });
    await screen.findByText("rules.md");
    fireEvent.click(screen.getByRole("button", { name: /parse documents/i }));
    await screen.findByText("Review draft memories");
    // Wait for the useTransition to settle so the Import button is enabled and
    // labelled with the settled selected-count before clicking (see toReview).
    const importButton = await screen.findByRole("button", {
      name: /import 2 memories/i,
    });
    await waitFor(() => expect(importButton).toBeEnabled());
    fireEvent.click(importButton);
    await screen.findByText("Import complete");
    return { onImported };
  }

  it("shows the imported count and fires onImported on success", async () => {
    const { onImported } = await importDrafts({
      ok: true,
      results: [
        { lesson: "Lesson A.", ok: true, memoryId: "n1", error: null },
        { lesson: "Lesson B.", ok: true, memoryId: "n2", error: null },
      ],
      imported: 2,
      failed: 0,
    });
    expect(screen.getByText("imported")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(
      screen.getByText(/the imported memories now appear in the list/i),
    ).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("lists failed rows when some writes fail", async () => {
    await importDrafts({
      ok: true,
      results: [
        { lesson: "Lesson A.", ok: true, memoryId: "n1", error: null },
        {
          lesson: "Lesson B.",
          ok: false,
          memoryId: null,
          error: "embedding failed",
        },
      ],
      imported: 1,
      failed: 1,
    });
    expect(screen.getByText("Failed rows")).toBeInTheDocument();
    const failed = screen.getByText("embedding failed");
    expect(failed).toBeInTheDocument();
    expect(
      within(failed.closest("li") as HTMLElement).getByText("Lesson B."),
    ).toBeInTheDocument();
  });
});
