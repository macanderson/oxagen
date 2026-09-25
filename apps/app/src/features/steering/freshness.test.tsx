// @vitest-environment jsdom
// The freshness panel: what it reports, who may change the two gates, and
// what a refused write leaves on screen. The last one is the point of the
// file — a checkbox that looks set and is not would tell an operator their
// workspace is protected when it is not.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SteeringFreshness } from "@/data/contracts/steering";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { steeringFreshness } from "@/test/steering-views";

// The panel re-renders itself through the router while a sync is pending, and
// a unit test has no app router mounted. One router object for the whole file,
// because `useNavigate` memoises on it.
const { router, setSteeringGate } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  setSteeringGate: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ setSteeringGate }));

const { Freshness } = await import("./freshness");

const AT = { org: "acme", ws: "core-platform" };

function show(
  read = steeringFreshness(),
  canEdit = true,
): { user: ReturnType<typeof userEvent.setup> } {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <Freshness at={AT} read={read} canEdit={canEdit} />
    </IntlProvider>,
  );
  return { user };
}

function box(gate: "autoSync" | "blockStaleRuns"): HTMLInputElement {
  // `data-gate` rather than a label lookup: the two hints are long, and a
  // name match would break every time the copy is reworded.
  const found = document.querySelector(`[data-gate="${gate}"]`);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`no checkbox for gate ${gate}`);
  }
  return found;
}

afterEach(async () => {
  setSteeringGate.mockReset();
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("what it reports", () => {
  it("prints the steering version, the repository and the newest record", () => {
    show();
    const panel = screen.getByRole("region", { name: "Steering freshness" });
    expect(panel).toHaveTextContent("12");
    expect(panel).toHaveTextContent("acme/platform");
    expect(panel).toHaveTextContent("main");
    // The commit is abbreviated, the way git prints it.
    expect(panel).toHaveTextContent("9a41c0e");
  });

  it("shows both gates, unchecked, when the workspace has set neither", () => {
    show();
    expect(box("autoSync").checked).toBe(false);
    expect(box("blockStaleRuns").checked).toBe(false);
  });

  it("shows a gate the workspace turned on", () => {
    show(
      steeringFreshness({ gates: { autoSync: false, blockStaleRuns: true } }),
    );
    expect(box("blockStaleRuns").checked).toBe(true);
  });
});

type Sync = NonNullable<SteeringFreshness["sync"]>;

const SYNC_HEAD = "abcdef1234567890abcdef1234567890abcdef12";

function sync(overrides: Partial<Sync> = {}): Sync {
  return {
    status: "synced",
    headSha: SYNC_HEAD,
    syncedAt: "2026-09-25T10:00:00.000Z",
    error: null,
    findings: [],
    ...overrides,
  };
}

function syncLine(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-sync]");
}

describe("the repository sync", () => {
  it("shows no sync line and no findings before the workspace's first sync", () => {
    // `sync: null` is every workspace that has not synced yet. The panel must
    // not invent a state for it.
    show();
    expect(syncLine()).toBeNull();
    expect(screen.queryByTestId("sync-findings")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names the commit the registry matches once the sync is done", () => {
    show(steeringFreshness({ sync: sync() }));
    const line = syncLine();
    expect(line?.dataset.sync).toBe("synced");
    // Abbreviated the way git prints it, so it can be found in the log.
    expect(line).toHaveTextContent("Matches abcdef1");
    expect(line).not.toHaveTextContent(SYNC_HEAD);
    expect(screen.queryByTestId("sync-findings")).toBeNull();
  });

  it("says a sync is on its way while one is pending", () => {
    show(
      steeringFreshness({
        sync: sync({ status: "pending", syncedAt: null }),
      }),
    );
    const line = syncLine();
    expect(line?.dataset.sync).toBe("pending");
    expect(line).toHaveTextContent(
      "Reading a new push or merge from the repository",
    );
  });

  it("names the error when the repository could not be read", () => {
    // The person reading this has to fix a token or a permission on the host;
    // the host's own words are the fastest route there.
    show(
      steeringFreshness({
        sync: sync({
          status: "failed",
          error: "GitHub answered 404 for acme/platform",
        }),
      }),
    );
    const line = syncLine();
    expect(line?.dataset.sync).toBe("failed");
    expect(line).toHaveTextContent(
      "Could not read the repository: GitHub answered 404 for acme/platform",
    );
  });

  it("counts the problems and lists each one with its level", () => {
    // A file with an error published nothing, and one with a warning
    // published anyway. The two read differently because the first means a
    // record the team merged is not in force.
    show(
      steeringFreshness({
        sync: sync({
          status: "problems",
          findings: [
            {
              level: "error",
              path: ".oxagen/rules/broken.toml",
              lineageId: null,
              message: ".oxagen/rules/broken.toml is not valid TOML",
            },
            {
              level: "warning",
              path: ".oxagen/rules/renamed.toml",
              lineageId: "ctx.release.renamed",
              message: "ctx.release.renamed moved to a new file",
            },
          ],
        }),
      }),
    );
    const line = syncLine();
    expect(line?.dataset.sync).toBe("problems");
    expect(line).toHaveTextContent("2 problems in the record files at abcdef1");

    const list = screen.getByTestId("sync-findings");
    expect(list).toHaveTextContent("Record file problems");
    const rows = list.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.dataset.level).toBe("error");
    expect(rows[0]).toHaveTextContent("Not published");
    expect(rows[0]).toHaveTextContent(
      ".oxagen/rules/broken.toml is not valid TOML",
    );
    expect(rows[1]?.dataset.level).toBe("warning");
    expect(rows[1]).toHaveTextContent("Published with a warning");
    expect(rows[1]).toHaveTextContent(
      "ctx.release.renamed moved to a new file",
    );
  });

  it("uses the singular for one problem", () => {
    show(
      steeringFreshness({
        sync: sync({
          status: "problems",
          findings: [
            {
              level: "error",
              path: ".oxagen/rules/broken.toml",
              lineageId: null,
              message: "not valid TOML",
            },
          ],
        }),
      }),
    );
    expect(syncLine()).toHaveTextContent("1 problem in the record files");
  });
});

describe("who may change them", () => {
  // Shown and disabled, not hidden: a person looking for the switches should
  // find them, and find out why they cannot be used yet.
  it("disables both gates when no repository is bound, and says so", () => {
    show(
      steeringFreshness({
        repository: null,
        defaultBranch: null,
        headCommit: null,
        publishedAt: null,
      }),
    );
    expect(box("autoSync")).toBeDisabled();
    expect(box("blockStaleRuns")).toBeDisabled();
    expect(
      screen.getByRole("region", { name: "Steering freshness" }),
    ).toHaveTextContent("No repository is bound");
  });

  it("disables both gates for a viewer who could not write them", () => {
    show(steeringFreshness(), false);
    expect(box("autoSync")).toBeDisabled();
    expect(box("blockStaleRuns")).toBeDisabled();
  });
});

describe("changing a gate", () => {
  it("writes one gate, not both, so two editors cannot overwrite each other", async () => {
    setSteeringGate.mockResolvedValue({
      ok: true,
      value: { autoSync: false, blockStaleRuns: true },
    });
    const { user } = show();
    await user.click(box("blockStaleRuns"));
    await waitFor(() => {
      expect(setSteeringGate).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "blockStaleRuns",
        true,
      );
    });
    expect(setSteeringGate).toHaveBeenCalledTimes(1);
    expect(box("blockStaleRuns").checked).toBe(true);
  });

  it("takes the value the write returned, not the one it sent", async () => {
    setSteeringGate.mockResolvedValue({
      ok: true,
      value: { autoSync: true, blockStaleRuns: true },
    });
    const { user } = show();
    await user.click(box("blockStaleRuns"));
    // Auto-sync was on in the stored policy all along; the panel now agrees.
    await waitFor(() => {
      expect(box("autoSync").checked).toBe(true);
    });
  });

  it("puts the checkbox back and names the refusal", async () => {
    setSteeringGate.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "workspace.settings.write",
    });
    const { user } = show();
    await user.click(box("blockStaleRuns"));
    await waitFor(() => {
      expect(box("blockStaleRuns").checked).toBe(false);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("puts the checkbox back when the write never answered", async () => {
    setSteeringGate.mockRejectedValue(new Error("network"));
    const { user } = show();
    await user.click(box("autoSync"));
    await waitFor(() => {
      expect(box("autoSync").checked).toBe(false);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
