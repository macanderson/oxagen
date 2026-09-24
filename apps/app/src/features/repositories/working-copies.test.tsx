// @vitest-environment jsdom
// The Working copies tab and its Connect a directory dialog on their own: each
// state the `list_working_copies` read can leave the table in (loading,
// refused, failed, empty, populated, at the read's ceiling), the gold moving
// off Connect when another tab holds it, and copying the commands saying
// whether it worked and forgetting that once the dialog closes.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkingCopy } from "@/data/contracts/repository";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { nth } from "@/test/nth";
import { WORKING_COPY_LIMIT } from "./view";
import { ConnectDirectoryDialog, WorkingCopies } from "./working-copies";

// The ceiling is 200 in the app. Here it is 3, so the ceiling case renders
// three rows rather than two hundred: axe runs after every case, and over a
// 200-row table it outlasts the hook timeout on a loaded CI runner.
vi.mock("./view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./view")>()),
  WORKING_COPY_LIMIT: 3,
}));

/** The instant the read settled: every last-seen time is relative to it. */
const READ_AT = new Date("2026-09-24T12:00:00.000Z");

const LAPTOP: WorkingCopy = {
  id: "wcp_laptop01",
  hostname: "mac-studio.local",
  directory: "/Users/mac/code/platform",
  repository: "acme/platform",
  branch: "feature/steering",
  headCommit: "0123456789abcdef0123456789abcdef01234567",
  oxagenPresent: true,
  symlinks: "linked",
  pulledCommit: "fedcba9876543210fedcba9876543210fedcba98",
  lastEvent: "pull",
  reportedBy: { userId: "usr_mac", name: "Mac Anderson" },
  cliVersion: "3.4.0",
  firstSeenAt: "2026-09-20T09:00:00.000Z",
  lastSeenAt: "2026-09-24T09:00:00.000Z",
};

const CI_BOX: WorkingCopy = {
  id: "wcp_ci02",
  hostname: "ci-runner-7",
  directory: "/srv/checkouts/docs-site",
  repository: null,
  branch: null,
  headCommit: null,
  oxagenPresent: false,
  symlinks: "missing",
  pulledCommit: null,
  lastEvent: "init",
  reportedBy: null,
  cliVersion: null,
  firstSeenAt: "2026-09-22T09:00:00.000Z",
  lastSeenAt: "2026-09-22T12:00:00.000Z",
};

type TabProps = ComponentProps<typeof WorkingCopies>;

function tab(overrides: Partial<TabProps> = {}) {
  const props: TabProps = {
    primary: true,
    onConnect: vi.fn(),
    copies: { kind: "ready", value: { workingCopies: [LAPTOP, CI_BOX] } },
    readAt: READ_AT,
    onRetry: vi.fn(),
    ...overrides,
  };
  render(
    <IntlProvider>
      <WorkingCopies {...props} />
    </IntlProvider>,
  );
  return props;
}

/**
 * Replace the clipboard for one test. `userEvent.setup()` installs its own,
 * so this runs after it and puts the original descriptor back.
 */
function stubClipboard(writeText: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
}

/** The dialog behind a button that opens it, the way the page holds it. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <WorkingCopies
        primary={false}
        onConnect={() => {
          setOpen(true);
        }}
        copies={{ kind: "ready", value: { workingCopies: [] } }}
        readAt={READ_AT}
        onRetry={vi.fn()}
      />
      <ConnectDirectoryDialog
        org="acme"
        ws="core-platform"
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Working copies", () => {
  it("draws Connect a directory as the small secondary when the tab does not hold the gold", () => {
    tab({ primary: false });
    const connect = screen.getByTestId("working-copies-connect");
    expect(connect.className).not.toContain("bg-button-primary-bg");
  });

  it("copies the command and says so, then forgets it once the dialog closes", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    const restore = stubClipboard(writeText);
    try {
      render(
        <IntlProvider>
          <Harness />
        </IntlProvider>,
      );
      await user.click(screen.getByTestId("working-copies-connect"));
      const dialog = await screen.findByTestId("linkdir-dialog");
      const copy = within(dialog).getByTestId("linkdir-copy");
      expect(copy).toHaveTextContent("Copy commands");
      await user.click(copy);
      expect(writeText).toHaveBeenCalledWith(
        "oxagen login\noxagen init --org acme --workspace core-platform\noxagen pull",
      );
      expect(copy).toHaveTextContent("Copied");

      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByTestId("linkdir-dialog")).toBeNull();
      });
      await user.click(screen.getByTestId("working-copies-connect"));
      expect(
        within(await screen.findByTestId("linkdir-dialog")).getByTestId(
          "linkdir-copy",
        ),
      ).toHaveTextContent("Copy commands");
    } finally {
      restore();
    }
  });

  it("says copying did not work and leaves the command to select (negative)", async () => {
    const user = userEvent.setup();
    const restore = stubClipboard(() =>
      Promise.reject(new Error("clipboard denied")),
    );
    try {
      render(
        <IntlProvider>
          <Harness />
        </IntlProvider>,
      );
      await user.click(screen.getByTestId("working-copies-connect"));
      const dialog = await screen.findByTestId("linkdir-dialog");
      await user.click(within(dialog).getByTestId("linkdir-copy"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Copying did not work. Select the commands and copy them.",
      );
      expect(within(dialog).getByTestId("linkdir-copy")).toHaveTextContent(
        "Copy commands",
      );
    } finally {
      restore();
    }
  });
});

describe("Working copies: the list_working_copies read", () => {
  it("draws one row per reported directory with every column the CLI sent", () => {
    tab();
    const table = screen.getByRole("table", {
      name: "Working copies of this workspace",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Directory",
      "Repository",
      "Branch",
      ".oxagen/",
      "Symlinks",
      "Pulled",
      "Last seen",
    ]);

    const laptop = screen.getByTestId("working-copy-wcp_laptop01");
    const cells = within(laptop).getAllByRole("cell");
    expect(nth(cells, 0, "working copy cell")).toHaveTextContent(
      "mac-studio.local",
    );
    const path = screen.getByTestId("working-copy-path-wcp_laptop01");
    expect(path).toHaveTextContent("/Users/mac/code/platform");
    expect(path.className).toContain("select-all");
    expect(nth(cells, 1, "working copy cell")).toHaveTextContent(
      "acme/platform",
    );
    expect(nth(cells, 2, "working copy cell")).toHaveTextContent(
      "feature/steering",
    );
    expect(nth(cells, 2, "working copy cell")).toHaveTextContent(
      "head 0123456",
    );
    expect(
      within(nth(cells, 3, "working copy cell")).getByText("present"),
    ).toHaveAttribute("data-oxagen", "present");
    expect(
      within(nth(cells, 4, "working copy cell")).getByText("linked"),
    ).toHaveAttribute("data-symlinks", "linked");
    expect(nth(cells, 5, "working copy cell")).toHaveTextContent("fedcba9");
    expect(nth(cells, 5, "working copy cell")).not.toHaveTextContent(
      "fedcba98765",
    );
    expect(nth(cells, 6, "working copy cell")).toHaveTextContent("3 hours ago");
    expect(nth(cells, 6, "working copy cell")).toHaveTextContent(
      "by Mac Anderson",
    );
    expect(
      within(nth(cells, 6, "working copy cell")).getByText("3 hours ago"),
    ).toHaveAttribute("dateTime", LAPTOP.lastSeenAt);
  });

  it("says what a report left out rather than drawing a blank (negative)", () => {
    tab();
    const cells = within(
      screen.getByTestId("working-copy-wcp_ci02"),
    ).getAllByRole("cell");
    expect(nth(cells, 0, "working copy cell")).toHaveTextContent("ci-runner-7");
    expect(nth(cells, 1, "working copy cell")).toHaveTextContent("No remote");
    expect(nth(cells, 2, "working copy cell")).toHaveTextContent(
      "Detached head",
    );
    expect(nth(cells, 2, "working copy cell")).not.toHaveTextContent("head ");
    expect(
      within(nth(cells, 3, "working copy cell")).getByText("absent"),
    ).toHaveAttribute("data-oxagen", "absent");
    expect(
      within(nth(cells, 4, "working copy cell")).getByText("missing"),
    ).toHaveAttribute("data-symlinks", "missing");
    expect(nth(cells, 5, "working copy cell")).toHaveTextContent(
      "Never pulled",
    );
    expect(nth(cells, 6, "working copy cell")).toHaveTextContent("2 days ago");
    expect(nth(cells, 6, "working copy cell")).toHaveTextContent("by a key");
  });

  it("tells a workspace no directory has reported to what to run, with no gap marker", () => {
    tab({ copies: { kind: "ready", value: { workingCopies: [] } } });
    const empty = screen.getByTestId("working-copies-empty");
    expect(empty).toHaveAttribute("data-state", "empty");
    expect(empty).toHaveTextContent(
      "No directory has reported to this workspace yet. Run the commands in Connect a directory",
    );
    expect(empty).toHaveTextContent(
      "The directory appears here once oxagen init reports it.",
    );
    expect(
      screen.getByTestId("working-copies-panel").querySelector("[data-gap]"),
    ).toBeNull();
    expect(screen.queryByTestId("working-copies-truncated")).toBeNull();
  });

  it("draws skeleton bars and announces the read while it is in flight", () => {
    tab({ copies: { kind: "loading" }, readAt: null });
    expect(
      screen.getByRole("status", { name: "Reading the working copies" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("working-copies-table")).toBeNull();
  });

  it("prints a failed read with its code and retries on request (negative)", async () => {
    const user = userEvent.setup();
    const props = tab({
      copies: {
        kind: "failed",
        failure: {
          ok: false,
          reason: "unavailable",
          code: "store_unreachable",
        },
      },
      readAt: null,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Oxagen could not read the working copies (store_unreachable). Try again in a moment.",
    );
    expect(screen.queryByTestId("working-copies-table")).toBeNull();
    await user.click(screen.getByTestId("working-copies-retry"));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("names the roles that may read the list when the read is refused (negative)", () => {
    tab({
      copies: {
        kind: "failed",
        failure: { ok: false, reason: "denied", code: "repository.read" },
      },
      readAt: null,
    });
    const denied = screen.getByTestId("working-copies-denied");
    expect(denied).toHaveAttribute("data-state", "denied");
    expect(denied).toHaveTextContent(
      "Your role cannot read this workspace’s working copies.",
    );
    expect(screen.queryByTestId("working-copies-retry")).toBeNull();
    expect(screen.queryByTestId("working-copies-table")).toBeNull();
  });

  it("says older rows are not listed when the read comes back at its ceiling", () => {
    const rows = Array.from({ length: WORKING_COPY_LIMIT }, (_, i) => ({
      ...LAPTOP,
      id: `wcp_row${String(i)}`,
    }));
    tab({ copies: { kind: "ready", value: { workingCopies: rows } } });
    expect(screen.getByTestId("working-copies-truncated")).toHaveTextContent(
      `Showing the ${String(WORKING_COPY_LIMIT)} most recently seen directories.`,
    );
  });

  it("lists the four sync commands the CLI has, and no command it lacks", () => {
    tab();
    const sync = screen.getByTestId("working-copies-sync");
    expect(
      Array.from(sync.querySelectorAll("[data-command]")).map((node) =>
        node.getAttribute("data-command"),
      ),
    ).toEqual([
      "oxagen init",
      "oxagen pull",
      "oxagen steering status",
      "oxagen context propose",
    ]);
    expect(sync).not.toHaveTextContent("Not in the CLI yet");
    expect(sync).toHaveTextContent("--force");
    expect(sync).toHaveTextContent(
      "oxagen init does not create stella’s links",
    );
  });
});

describe("Connect a directory", () => {
  it("gives the three commands, what they write and report, and no pairing code", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <Harness />
      </IntlProvider>,
    );
    await user.click(screen.getByTestId("working-copies-connect"));
    const dialog = await screen.findByTestId("linkdir-dialog");
    const command = within(dialog).getByTestId("linkdir-command");
    expect(command.textContent).toBe(
      "oxagen login  # once per machine\noxagen init --org acme --workspace core-platform\noxagen pull",
    );
    expect(dialog).not.toHaveTextContent("Pairing");
    expect(dialog.querySelector("[data-gap]")).toBeNull();
    expect(within(dialog).getByTestId("linkdir-hint")).toHaveTextContent(
      "The directory appears on the Working copies tab once oxagen init reports it.",
    );
    const writes = within(dialog).getByTestId("linkdir-writes");
    expect(
      Array.from(writes.querySelectorAll("[data-row]")).map((row) =>
        row.getAttribute("data-row"),
      ),
    ).toEqual(["writes", "reports", "pull", "noRead"]);
    expect(writes).toHaveTextContent(".gitignore");
    expect(writes).toHaveTextContent("--force");
    expect(dialog).toHaveTextContent("Linking a directory grants nothing.");
  });
});
