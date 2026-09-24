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

const { ExportAction, SummarizeAction } = await import("./record-actions");

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
      <ExportAction
        org="acme"
        ws="core-platform"
        runId={RUN}
        sealed
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

  it("schedules no further read when one lands after the dialog is gone", async () => {
    let answer: (value: unknown) => void = () => undefined;
    readRunExport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    readRunExport.mockResolvedValue(exportAt("queued"));
    const { view } = await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(readRunExport).toHaveBeenCalledTimes(1);
    view.unmount();
    // A queued answer would schedule the next read if the dialog still followed it.
    await act(async () => {
      answer(exportAt("queued"));
      await Promise.resolve();
    });
    await advance(EXPORT_POLL_BUDGET_MS);
    expect(readRunExport).toHaveBeenCalledTimes(1);
  });

  it("reads a ready bundle whose job kept no size, digest or link as not recorded, and offers no download (negative)", async () => {
    readRunExport.mockResolvedValue(exportAt("ready"));
    await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    const ready = screen.getByTestId("export-ready");
    expect(screen.getByTestId("export-size")).toHaveTextContent("Not recorded");
    expect(screen.queryByTestId("export-digest")).toBeNull();
    expect(screen.queryByTestId("export-download")).toBeNull();
    expect(ready).not.toHaveTextContent("Link expires");
    // The command still names the bundle a person would download.
    expect(screen.getByTestId("export-verify-command")).toHaveTextContent(
      `oxagen verify ${RUN}-${EXPORT}.zip`,
    );
  });

  it("copies the whole digest, and says the browser refused when the clipboard does (negative)", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    readRunExport.mockResolvedValue(READY);
    const { user } = await queueExport();
    // After user-event's setup, which puts its own clipboard stub in place.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      await advance(EXPORT_POLL_FIRST_MS);
      await user.click(screen.getByRole("button", { name: "Copy" }));
      await advance(0);
      expect(writeText).toHaveBeenCalledWith(DIGEST);
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
      writeText.mockImplementationOnce(() =>
        Promise.reject(new Error("NotAllowedError")),
      );
      await user.click(screen.getByRole("button", { name: "Copied" }));
      await advance(0);
      expect(
        screen.getByText(
          "This browser refused the clipboard. Select the digest and copy it.",
        ),
      ).toBeTruthy();
      // The button never claims a copy that failed.
      expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("says the export failed without inventing a cause when the job recorded none (negative)", async () => {
    readRunExport.mockResolvedValue(exportAt("failed"));
    await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(screen.getByTestId("export-failed")).toHaveTextContent(
      "The export failed, and the job recorded no error.",
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "a denied read",
      { ok: false, reason: "denied", code: "run.export.read" },
      "Reading an export needs an organization Owner or Admin role.",
    ],
    [
      "a read parked for approval",
      { ok: false, reason: "pending_approval", accessRequestId: "areq_1" },
      "Oxagen answered pending_approval when asked for this export.",
    ],
  ])(
    "names %s and offers no Check again, since another read would answer the same (negative)",
    async (_, refusal, words) => {
      readRunExport.mockResolvedValue(refusal);
      await queueExport();
      await advance(EXPORT_POLL_FIRST_MS);
      expect(screen.getByTestId("export-read-failure")).toHaveTextContent(
        words,
      );
      expect(screen.queryByTestId("export-check-again")).toBeNull();
      const reads = readRunExport.mock.calls.length;
      await advance(60_000);
      expect(readRunExport).toHaveBeenCalledTimes(reads);
    },
  );

  it("treats a read that throws as one the control plane could not serve, and offers Check again (negative)", async () => {
    readRunExport.mockRejectedValue(new Error("network"));
    await queueExport();
    await advance(EXPORT_POLL_FIRST_MS);
    expect(screen.getByTestId("export-read-failure")).toHaveTextContent(
      "Oxagen answered read_failed when asked for this export.",
    );
    expect(screen.getByTestId("export-check-again")).toBeTruthy();
  });
});

describe("the record dialog", () => {
  it("closes on Re-read, refreshes the route, and opens again on the form rather than the old receipt", async () => {
    readRunExport.mockResolvedValue(exportAt("queued"));
    const { user } = await queueExport();
    expect(screen.getByTestId("queued-receipt")).toHaveTextContent(EXPORT);
    await user.click(screen.getByRole("button", { name: "Re-read the run" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("run-export-dialog")).toBeNull();
    await user.click(screen.getByTestId("run-export"));
    expect(screen.queryByTestId("queued-receipt")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Queue the bundle" }),
    ).toBeTruthy();
  });

  it("sends one write while the first is in flight, however often the button is pressed", async () => {
    exportRun.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <IntlProvider>
        <ExportAction
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed
          orgRole="admin"
        />
      </IntlProvider>,
    );
    await user.click(screen.getByTestId("run-export"));
    await user.click(screen.getByRole("button", { name: "Queue the bundle" }));
    // The pending button is aria-disabled, not disabled, so this click submits.
    await user.click(screen.getByRole("button", { name: "Queueing" }));
    expect(exportRun).toHaveBeenCalledTimes(1);
  });

  it("says the write went unanswered when the action itself throws (negative)", async () => {
    exportRun.mockRejectedValue(new Error("network"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <IntlProvider>
        <ExportAction
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed
          orgRole="owner"
        />
      </IntlProvider>,
    );
    await user.click(screen.getByTestId("run-export"));
    await user.click(screen.getByRole("button", { name: "Queue the bundle" }));
    expect(await screen.findByTestId("run-export-failure")).toBeTruthy();
    expect(screen.queryByTestId("queued-receipt")).toBeNull();
  });
});

describe("SummarizeAction", () => {
  it("draws Summarize disabled for a recording that kept no bodies, and says why (negative)", () => {
    render(
      <IntlProvider>
        <SummarizeAction
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
    const button = screen.getByTestId("run-summarize");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-reason", "summarize-no-bodies");
    expect(button.getAttribute("title")).toContain(
      "kept digests and no bodies",
    );
  });

  it("offers nothing on a live run, whose summary the sweep writes as it records (negative)", () => {
    const { container } = render(
      <IntlProvider>
        <SummarizeAction
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed={false}
          hasSummary={false}
          summarizable
          orgRole="owner"
        />
      </IntlProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("queues a summary and prints the run it was queued for", async () => {
    summarizeRun.mockResolvedValue({ ok: true, value: { runId: RUN } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <IntlProvider>
        <SummarizeAction
          org="acme"
          ws="core-platform"
          runId={RUN}
          sealed
          hasSummary
          summarizable
          orgRole="member"
        />
      </IntlProvider>,
    );
    await user.click(screen.getByTestId("run-resummarize"));
    await user.click(screen.getByRole("button", { name: "Queue the summary" }));
    expect(summarizeRun).toHaveBeenCalledWith("acme", "core-platform", RUN);
    expect(await screen.findByTestId("queued-receipt")).toHaveTextContent(RUN);
  });
});
