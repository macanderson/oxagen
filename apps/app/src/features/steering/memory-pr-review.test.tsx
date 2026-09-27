// @vitest-environment jsdom
// A memory PR's records as a person reviews them (#4518): each card shows the
// record, the memories it cites with the agent each came from, and links to
// the runs its evidence names. Drop removes one record and marks its card in
// place, a record dropped earlier shows its commit, and a refusal is named on
// the card. Each state gets an axe check.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { AT } from "@/test/steering-views";
import {
  MEMORY_BRANCH,
  memoryPrMemory,
  memoryPrRecord,
} from "./memory-pr-review.builders";

const { router, dropMemoryRecord } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  dropMemoryRecord: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  openContextPr: vi.fn(),
  mergeContextPr: vi.fn(),
  dismissProposal: vi.fn(),
  approveContextPr: vi.fn(),
  mergePrWithoutReview: vi.fn(),
  restoreManagedBlock: vi.fn(),
  dropMemoryRecord,
}));

const { MemoryPrReview } = await import("./memory-pr-review");

const KEPT = memoryPrRecord({
  memories: [
    memoryPrMemory({
      evidence: [
        "frame:arun_01k5rs7m/14",
        "frame:tse_01k5rt2q/3",
        "ci-log:release-417",
      ],
    }),
    memoryPrMemory({
      statement: "The release notes named the changelog as read.",
      agent: null,
      run: null,
      evidence: [],
    }),
  ],
});
const DROPPED = memoryPrRecord({
  path: ".oxagen/memory/release.skip-lockfile-check.toml",
  lineage: "mem.release.skip-lockfile-check",
  title: "Skip the lockfile check",
  summary: "Skip the lockfile check when only docs changed.",
  dropped: { commitSha: "4d5e6f7a8b9c" },
});

function renderReview(records = [KEPT, DROPPED]) {
  render(
    <IntlProvider>
      <MemoryPrReview at={AT} branch={MEMORY_BRANCH} records={records} />
    </IntlProvider>,
  );
}

function card(path: string): HTMLElement {
  const found = document.querySelector(`[data-memory-record="${path}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no card for ${path}`);
  return found;
}

const drop = () =>
  screen.queryByRole("button", { name: "Drop Do not re-read the changelog" });

beforeEach(() => {
  for (const fn of [
    router.push,
    router.replace,
    router.refresh,
    dropMemoryRecord,
  ]) {
    fn.mockReset();
  }
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the records", () => {
  it("shows a kept record with its memories, their agents and their runs", () => {
    renderReview();
    const kept = card(KEPT.path);
    expect(
      within(kept).getByRole("heading", {
        level: 4,
        name: "Do not re-read the changelog",
      }),
    ).toBeInTheDocument();
    expect(kept).toHaveTextContent(KEPT.path);
    expect(kept).toHaveTextContent("Read CHANGELOG.md once per release run.");
    expect(kept).toHaveTextContent("Cited memories");
    const memories = kept.querySelectorAll("[data-memory]");
    expect(memories).toHaveLength(2);
    const [seen, unattributed] = memories;
    if (!(seen instanceof HTMLElement)) throw new Error("no first memory");
    expect(seen.querySelector("[data-agent]")).toHaveTextContent(
      "release-bot",
    );
    // The memory's own run and the frame from it name one run, linked once.
    expect(
      within(seen)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["arun_01k5rs7m", "/acme/core-platform/runs/arun_01k5rs7m"],
      ["tse_01k5rt2q", "/acme/core-platform/runs/tse_01k5rt2q"],
    ]);
    expect(seen).toHaveTextContent("ci-log:release-417");
    expect(drop()).toBeEnabled();
    if (!(unattributed instanceof HTMLElement)) {
      throw new Error("no second memory");
    }
    expect(unattributed.querySelector("[data-agent]")).toHaveTextContent(
      "Unknown agent",
    );
    expect(unattributed).not.toHaveTextContent("Evidence");
    expect(within(unattributed).queryByRole("link")).toBeNull();
  });

  it("marks a record dropped earlier with its commit and offers no Drop (negative)", () => {
    renderReview();
    const dropped = card(DROPPED.path);
    expect(dropped.querySelector("[data-dropped]")).toHaveTextContent(
      "Dropped in 4d5e6f7",
    );
    expect(within(dropped).queryByRole("button")).toBeNull();
  });
});

describe("Drop", () => {
  it("drops the record from the memory branch and marks its card in place", async () => {
    dropMemoryRecord.mockResolvedValue({
      ok: true,
      value: { commitSha: "a1b2c3d4e5f6", rejectionId: "mrj_01k5sz4n" },
    });
    renderReview([KEPT]);
    const button = drop();
    if (button === null) throw new Error("no Drop button");
    fireEvent.click(button);
    expect(await screen.findByText("Dropped in a1b2c3d")).toBeInTheDocument();
    expect(dropMemoryRecord).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      MEMORY_BRANCH,
      KEPT.path,
    );
    expect(drop()).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("says the platform has not registered Drop yet and keeps the record (negative)", async () => {
    dropMemoryRecord.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "tool_not_registered",
    });
    renderReview([KEPT]);
    const button = drop();
    if (button === null) throw new Error("no Drop button");
    fireEvent.click(button);
    expect(
      await screen.findByTestId("drop-memory-record-failure"),
    ).toHaveTextContent("Oxagen has not registered this action yet.");
    expect(drop()).toBeEnabled();
    expect(card(KEPT.path).querySelector("[data-dropped]")).toBeNull();
  });

  it("names a write that threw and keeps the record (negative)", async () => {
    dropMemoryRecord.mockRejectedValue(new Error("socket closed"));
    renderReview([KEPT]);
    const button = drop();
    if (button === null) throw new Error("no Drop button");
    fireEvent.click(button);
    expect(
      await screen.findByTestId("drop-memory-record-failure"),
    ).toHaveTextContent("The change could not be made: action_failed.");
    expect(drop()).toBeEnabled();
  });
});
