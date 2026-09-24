// @vitest-environment jsdom
// The export dialog after `export_run` answers: it reads the export back on a
// bounded schedule (`get_run_export`) and says where the bundle stands.
//
// The rules these hold: the dialog offers a download only once the export is
// ready, and links the URL the read answered. It stops reading once the export
// is ready or failed, because each read mints a fresh token. It stops after
// its budget and hands over to "Check again". A refused read names the
// refusal, and a closed dialog reads nothing more.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { exportRun, readRunExport, summarizeRun, refresh } = vi.hoisted(() => ({
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
  summarizeRun: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./actions", () => ({ exportRun, readRunExport, summarizeRun }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));

const { RecordActions } = await import("./record-actions");

// The dialog's poll timing, mirrored from record-actions.tsx: the first read
// at 2s, each wait 1.5 times the last, and reading stops after 120s.
const EXPORT_POLL_FIRST_MS = 2_000;
const EXPORT_POLL_BACKOFF = 1.5;
const EXPORT_POLL_BUDGET_MS = 120_000;

const RUN = "tse_7k2m9q";
const EXPORT = "rexp_1";
const URL_READY = "https://api.oxagen.sh/v1/run-exports/download?token=t0k";
const DIGEST = `sha256:${"a".repeat(64)}`;

function exportAt(
  status: "queued" | "building" | "ready" | "failed",
  extra: Record<string, unknown> = {},
) {
  return {
    ok: true,
    value: {
      exportId: EXPORT,
      runId: RUN,
      status,
      createdAt: "2026-09-22T10:00:00.000Z",
      completedAt: null,
      bundleDigest: null,
      bundleBytes: null,
      merkleRoot: null,
      frameCount: null,
      error: null,
      download: null,
      ...extra,
    },
  };
}

const READY = exportAt("ready", {
  completedAt: "2026-09-22T10:00:07.000Z",
  bundleDigest: DIGEST,
  bundleBytes: 48_213,
  merkleRoot: `sha256:${"b".repeat(64)}`,
  frameCount: 412,
  download: { url: URL_READY, expiresAt: "2026-09-22T10:15:07.000Z" },
});

/** Advance the poll clock and let the reads it fires answer. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Open Export, queue the bundle, and wait for the dialog to start following it. */
async function queueExport() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = render(
    <IntlProvider>
      <RecordActions
        org="acme"
        ws="core-platform"
        runId={RUN}
        sealed
        hasSummary
        summarizable
        orgRole="owner"
      />
    </IntlProvider>,
  );
  await user.click(screen.getByTestId("run-export"));
  await user.click(screen.getByRole("button", { name: "Queue the bundle" }));
  await waitFor(() => {
    expect(screen.getByTestId("export-status")).toBeTruthy();
  });
  return { user, view };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  for (const fn of [exportRun, readRunExport, summarizeRun, refresh]) {
    fn.mockReset();
  }
  exportRun.mockResolvedValue({ ok: true, value: { exportId: EXPORT } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("export status", () => {
  it("follows a queued export to ready and links the URL the read answered", async () => {
    readRunExport
      .mockResolvedValueOnce(exportAt("queued"))
      .mockResolvedValueOnce(exportAt("building"))
      .mockResolvedValue(READY);
    await queueExport();

    await advance(EXPORT_POLL_FIRST_MS);
    expect(screen.getByTestId("export-progress")).toHaveTextContent(
      "Waiting for the job to start.",
    );
    expect(screen.queryByTestId("export-download")).toBeNull();

    await advance(EXPORT_POLL_FIRST_MS * EXPORT_POLL_BACKOFF);
    expect(screen.getByTestId("export-progress")).toHaveTextContent(
      "Oxagen is building the bundle.",
    );

    await advance(EXPORT_POLL_FIRST_MS * EXPORT_POLL_BACKOFF ** 2);
    const link = screen.getByTestId("export-download");
    expect(link).toHaveAttribute("href", URL_READY);
    expect(link).toHaveAttribute("download");
    expect(screen.getByTestId("export-size")).toHaveTextContent(/48\.2\s?kB/);
    const digest = screen.getByTestId("export-digest");
    expect(digest).toHaveAttribute("title", DIGEST);
    expect(digest.textContent).not.toBe(DIGEST);
    expect(screen.getByTestId("export-verify-command")).toHaveTextContent(
      `oxagen verify ${RUN}-${EXPORT}.zip`,
    );
    expect(readRunExport).toHaveBeenCalledWith("acme", "core-platform", EXPORT);

    // A ready export is not read again on its own: each read mints a token.
    const reads = readRunExport.mock.calls.length;
    await advance(60_000);
    expect(readRunExport).toHaveBeenCalledTimes(reads);

    vi.useRealTimers();
    await expectNoAxe(document.body);
  });

  it("shows the job's error when the export failed, and offers no download (negative)", async () => {
    readRunExport.mockResolvedValue(
      exportAt("failed", { error: "bundle upload refused" }),
    );
    await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(screen.getByTestId("export-failed")).toHaveTextContent(
      "The export failed: bundle upload refused",
    );
    expect(screen.queryByTestId("export-download")).toBeNull();

    const reads = readRunExport.mock.calls.length;
    await advance(60_000);
    expect(readRunExport).toHaveBeenCalledTimes(reads);
  });

  it("stops after its budget and reads again at once on Check again", async () => {
    readRunExport.mockResolvedValue(exportAt("building"));
    const { user } = await queueExport();
    await advance(EXPORT_POLL_BUDGET_MS + 10_000);
    expect(screen.getByTestId("export-stalled")).toHaveTextContent(
      "not ready yet",
    );

    const reads = readRunExport.mock.calls.length;
    await advance(60_000);
    expect(readRunExport).toHaveBeenCalledTimes(reads);

    readRunExport.mockResolvedValue(READY);
    await user.click(screen.getByTestId("export-check-again"));
    await advance(0);
    expect(readRunExport).toHaveBeenCalledTimes(reads + 1);
    expect(screen.getByTestId("export-download")).toHaveAttribute(
      "href",
      URL_READY,
    );
  });

  it("names an export from another workspace as not in this workspace (negative)", async () => {
    readRunExport.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "run_export_not_found",
    });
    await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(screen.getByTestId("export-read-failure")).toHaveTextContent(
      "This export is not in this workspace.",
    );
    // Another read would get the same answer, so none is offered.
    expect(screen.queryByTestId("export-check-again")).toBeNull();
    expect(screen.queryByTestId("export-download")).toBeNull();
  });

  it("offers Check again when the read itself could not be served, and reads once more on it", async () => {
    readRunExport.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "export_store_unreachable",
    });
    const { user } = await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(screen.getByTestId("export-read-failure")).toHaveTextContent(
      "export_store_unreachable",
    );
    const reads = readRunExport.mock.calls.length;
    readRunExport.mockResolvedValue(READY);
    await user.click(screen.getByTestId("export-check-again"));
    await advance(0);
    expect(readRunExport).toHaveBeenCalledTimes(reads + 1);
    expect(screen.getByTestId("export-download")).toHaveAttribute(
      "href",
      URL_READY,
    );
  });

  it("does not link a download URL off the signed download path (negative)", async () => {
    readRunExport.mockResolvedValue(
      exportAt("ready", {
        bundleDigest: DIGEST,
        bundleBytes: 10,
        download: {
          url: "https://elsewhere.example/steal?token=t0k",
          expiresAt: "2026-09-22T10:15:07.000Z",
        },
      }),
    );
    await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(screen.getByTestId("export-ready")).toBeTruthy();
    expect(screen.queryByTestId("export-download")).toBeNull();
  });

  it("reads nothing more once the dialog is gone", async () => {
    readRunExport.mockResolvedValue(exportAt("queued"));
    const { view } = await queueExport();
    view.unmount();
    await advance(EXPORT_POLL_BUDGET_MS);
    expect(readRunExport).not.toHaveBeenCalled();
  });
});

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

describe("export status, what the read did not record", () => {
  it("says the size is not recorded, and shows no digest, link or expiry it was not given", async () => {
    readRunExport.mockResolvedValue(exportAt("ready"));
    await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    const ready = screen.getByTestId("export-ready");
    expect(screen.getByTestId("export-size")).toHaveTextContent("Not recorded");
    expect(screen.queryByTestId("export-digest")).toBeNull();
    expect(screen.queryByTestId("export-download")).toBeNull();
    expect(ready).not.toHaveTextContent("Link expires");
  });

  it("says the export failed with no error recorded rather than inventing one (negative)", async () => {
    readRunExport.mockResolvedValue(exportAt("failed"));
    await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(screen.getByTestId("export-failed")).toHaveTextContent(
      "The export failed, and the job recorded no error.",
    );
  });

  it.each([
    [
      { ok: false, reason: "denied", code: "org_role_required" },
      "Reading an export needs an organization Owner or Admin role.",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_9" },
      "Oxagen answered pending_approval when asked for this export.",
    ],
  ] as const)(
    "names the read's refusal %o (negative)",
    async (refusal, sentence) => {
      readRunExport.mockResolvedValue(refusal);
      await queueExport();
      await advance(EXPORT_POLL_FIRST_MS);
      expect(screen.getByTestId("export-read-failure")).toHaveTextContent(
        sentence,
      );
    },
  );

  it("drops a read that answers after the dialog is gone", async () => {
    let answer!: (value: unknown) => void;
    readRunExport.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { view } = await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(readRunExport).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => {
      answer(exportAt("queued"));
      await Promise.resolve();
    });
    // A queued answer would schedule the next read; the unmounted dialog
    // schedules none.
    await advance(EXPORT_POLL_BUDGET_MS);
    expect(readRunExport).toHaveBeenCalledOnce();
  });
});

describe("the bundle digest", () => {
  it("copies the whole digest and says so", async () => {
    readRunExport.mockResolvedValue(READY);
    const { user } = await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    const writeText = vi.fn(() => Promise.resolve());
    const restore = stubClipboard(writeText);
    try {
      await user.click(screen.getByRole("button", { name: "Copy" }));
      expect(writeText).toHaveBeenCalledWith(DIGEST);
      expect(
        await screen.findByRole("button", { name: "Copied" }),
      ).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("says the browser refused the clipboard (negative)", async () => {
    readRunExport.mockResolvedValue(READY);
    const { user } = await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    const restore = stubClipboard(() =>
      Promise.reject(new Error("clipboard denied")),
    );
    try {
      await user.click(screen.getByRole("button", { name: "Copy" }));
      expect(
        await screen.findByText(
          "This browser refused the clipboard. Select the digest and copy it.",
        ),
      ).toBeTruthy();
    } finally {
      restore();
    }
  });
});

describe("what the viewer may do", () => {
  it("disables Summarize on a recording with no bodies, and says why, for a role that could summarize", () => {
    render(
      <IntlProvider>
        <RecordActions
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed
          hasSummary={false}
          summarizable={false}
          orgRole="owner"
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("run-summarize")).toBeDisabled();
    expect(screen.getByTestId("summarize-no-bodies")).toHaveTextContent(
      "This recording kept digests and no bodies",
    );
    expect(screen.queryByTestId("summarize-no-role")).toBeNull();
  });
});
