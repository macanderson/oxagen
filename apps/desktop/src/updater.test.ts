import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { beforeEach, describe, expect, it, vi } from "vitest";

const relaunch = vi.fn(async () => {});
const check = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));

const {
  applyDownloadEvent,
  checkForUpdate,
  describeCheck,
  describeRestart,
  DOWNLOAD_START,
  formatBytes,
  installInBackground,
  installUpdate,
} = await import("./updater");

const MB = 1024 * 1024;

/** The plugin's Update class carries fields the tests do not exercise. */
const asUpdate = (partial: Partial<Update>): Update => partial as Update;

describe("describeCheck", () => {
  it("names the version on offer, or says the install is current", () => {
    expect(describeCheck({ available: false, currentVersion: "2.1.1" })).toBe(
      "up to date (v2.1.1)",
    );
    expect(
      describeCheck({
        available: true,
        version: "2.2.0",
        currentVersion: "2.1.1",
      }),
    ).toBe("v2.2.0 available");
  });
});

describe("formatBytes", () => {
  it("prints B, KB and one-decimal MB", () => {
    expect(formatBytes(40)).toBe("40 B");
    expect(formatBytes(812 * 1024)).toBe("812 KB");
    expect(formatBytes(79.5 * MB)).toBe("79.5 MB");
    expect(formatBytes(-1)).toBe("?");
    expect(formatBytes(Number.NaN)).toBe("?");
  });
});

describe("applyDownloadEvent", () => {
  it("announces the size on Started and resets the totals", () => {
    const seeded = { received: 5 * MB, total: 10 * MB, lastMark: 50 };
    const r = applyDownloadEvent(seeded, {
      event: "Started",
      data: { contentLength: 80 * MB },
    });
    expect(r.line).toBe("Downloading 80.0 MB…");
    expect(r.progress).toEqual({ received: 0, total: 80 * MB, lastMark: -1 });
    expect(
      applyDownloadEvent(DOWNLOAD_START, { event: "Started", data: {} }).line,
    ).toBe("Downloading…");
  });

  it("logs a line only when a tenth-percent milestone is crossed", () => {
    let p = applyDownloadEvent(DOWNLOAD_START, {
      event: "Started",
      data: { contentLength: 100 * MB },
    }).progress;
    const lines: string[] = [];
    // 200 chunks of 512 KB: 100 MB. Ten milestones plus the 0% opener.
    for (let i = 0; i < 200; i++) {
      const r = applyDownloadEvent(p, {
        event: "Progress",
        data: { chunkLength: MB / 2 },
      });
      p = r.progress;
      if (r.line !== null) lines.push(r.line);
    }
    expect(p.received).toBe(100 * MB);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("  0% · 512 KB of 100.0 MB");
    expect(lines[5]).toBe("  50% · 50.0 MB of 100.0 MB");
    expect(lines[10]).toBe("  100% · 100.0 MB of 100.0 MB");
  });

  it("falls back to a line per 10 MB when the feed sent no length", () => {
    let p = applyDownloadEvent(DOWNLOAD_START, {
      event: "Started",
      data: {},
    }).progress;
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      const r = applyDownloadEvent(p, {
        event: "Progress",
        data: { chunkLength: MB },
      });
      p = r.progress;
      if (r.line !== null) lines.push(r.line);
    }
    expect(lines).toEqual([
      "  1.0 MB received",
      "  10.0 MB received",
      "  20.0 MB received",
    ]);
  });

  it("reports the received total on Finished", () => {
    const r = applyDownloadEvent(
      { received: 79.5 * MB, total: 79.5 * MB, lastMark: 100 },
      { event: "Finished" },
    );
    expect(r.line).toBe(
      "Downloaded 79.5 MB; verifying the signature and installing…",
    );
  });
});

describe("checkForUpdate", () => {
  beforeEach(() => {
    check.mockReset();
    relaunch.mockClear();
  });

  it("maps a null handle to up-to-date with the running version", async () => {
    check.mockResolvedValue(null);
    await expect(checkForUpdate("2.1.1")).resolves.toEqual({
      result: { available: false, currentVersion: "2.1.1" },
      update: null,
    });
  });

  it("carries the offered version, body and handle through", async () => {
    const handle = {
      version: "2.2.0",
      currentVersion: "2.1.1",
      body: "notes",
      downloadAndInstall: vi.fn(),
    };
    check.mockResolvedValue(handle);
    const r = await checkForUpdate("2.1.1");
    expect(r.result).toEqual({
      available: true,
      version: "2.2.0",
      currentVersion: "2.1.1",
      body: "notes",
    });
    expect(r.update).toBe(handle);
  });

  it("bounds the check, so a feed that never answers fails instead of spinning", async () => {
    check.mockResolvedValue(null);
    await checkForUpdate("2.1.1");
    expect(check).toHaveBeenCalledWith({ timeout: 30_000 });
  });

  it("rejects when the feed does, so the caller can show the error", async () => {
    check.mockRejectedValue(new Error("Could not fetch a valid release JSON"));
    await expect(checkForUpdate("2.1.1")).rejects.toThrow(/release JSON/);
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe("installUpdate", () => {
  it("streams milestone lines, then relaunches after the install", async () => {
    relaunch.mockClear();
    const lines: string[] = [];
    const update = {
      version: "2.2.0",
      currentVersion: "2.1.1",
      downloadAndInstall: vi.fn(
        async (onEvent?: (e: DownloadEvent) => void): Promise<void> => {
          onEvent?.({ event: "Started", data: { contentLength: 4 * MB } });
          onEvent?.({ event: "Progress", data: { chunkLength: 2 * MB } });
          onEvent?.({ event: "Progress", data: { chunkLength: 2 * MB } });
          onEvent?.({ event: "Finished" });
        },
      ),
    };
    await installUpdate(asUpdate(update), (l) => lines.push(l));
    expect(lines).toEqual([
      "Downloading 4.0 MB…",
      "  50% · 2.0 MB of 4.0 MB",
      "  100% · 4.0 MB of 4.0 MB",
      "Downloaded 4.0 MB; verifying the signature and installing…",
      "Installed v2.2.0.",
      "Relaunching…",
    ]);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("runs afterInstall between the install and the relaunch", async () => {
    relaunch.mockClear();
    const order: string[] = [];
    const update = {
      version: "2.2.0",
      currentVersion: "2.1.1",
      downloadAndInstall: vi.fn(async () => {
        order.push("install");
      }),
    };
    relaunch.mockImplementationOnce(async () => {
      order.push("relaunch");
    });
    await installUpdate(
      asUpdate(update),
      () => {},
      async () => {
        order.push("after");
      },
    );
    expect(order).toEqual(["install", "after", "relaunch"]);
  });

  it("still relaunches when afterInstall throws, and logs why", async () => {
    relaunch.mockClear();
    const lines: string[] = [];
    const update = {
      version: "2.2.0",
      currentVersion: "2.1.1",
      downloadAndInstall: vi.fn(async () => {}),
    };
    await expect(
      installUpdate(
        asUpdate(update),
        (line) => lines.push(line),
        async () => {
          throw new Error("launchctl missing");
        },
      ),
    ).resolves.toEqual({ relaunched: true });
    expect(lines).toContain("After the install: launchctl missing");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch when the install throws", async () => {
    relaunch.mockClear();
    const update = {
      version: "2.2.0",
      currentVersion: "2.1.1",
      downloadAndInstall: vi.fn(async () => {
        throw new Error("signature mismatch");
      }),
    };
    await expect(installUpdate(asUpdate(update), () => {})).rejects.toThrow(
      /signature/,
    );
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe("a relaunch that fails after the install landed", () => {
  it("is not an update failure: the new build is installed, so it says to reopen", async () => {
    relaunch.mockClear();
    relaunch.mockRejectedValueOnce(new Error("relaunch not permitted"));
    const lines: string[] = [];
    const update = {
      version: "2.2.0",
      currentVersion: "2.1.1",
      downloadAndInstall: vi.fn(async () => {}),
    };
    await expect(
      installUpdate(asUpdate(update), (line) => lines.push(line)),
    ).resolves.toEqual({ relaunched: false });
    expect(lines.at(-1)).toContain("Quit Oxagen and open it again");
  });
});

describe("installInBackground", () => {
  /** A handle whose download and install record their turn in `order`. */
  function recordingUpdate(order: string[], failInstall = false) {
    return {
      version: "2.2.0",
      currentVersion: "2.1.1",
      download: vi.fn(
        async (onEvent?: (e: DownloadEvent) => void): Promise<void> => {
          order.push("download");
          onEvent?.({ event: "Started", data: { contentLength: 4 * MB } });
          onEvent?.({ event: "Progress", data: { chunkLength: 4 * MB } });
          onEvent?.({ event: "Finished" });
        },
      ),
      install: vi.fn(async () => {
        order.push("install");
        if (failInstall) throw new Error("rename failed");
      }),
      downloadAndInstall: vi.fn(),
    };
  }

  beforeEach(() => {
    relaunch.mockClear();
  });

  it("downloads unheld, installs under the hold, restarts the collector, then lets go", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const update = recordingUpdate(order);
    await installInBackground(
      asUpdate(update),
      async (holding) => {
        order.push(holding ? "hold" : "release");
      },
      async () => {
        order.push("after");
      },
      (line) => lines.push(line),
    );
    expect(order).toEqual(["download", "hold", "install", "after", "release"]);
    expect(lines).toEqual([
      "Downloading 4.0 MB…",
      "  100% · 4.0 MB of 4.0 MB",
      "Downloaded 4.0 MB; verifying the signature and installing…",
      "Installed v2.2.0. Restart Oxagen to use it.",
    ]);
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("never relaunches", async () => {
    await installInBackground(
      asUpdate(recordingUpdate([])),
      async () => {},
      async () => {},
      () => {},
    );
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("releases the hold and rejects when the install fails, so the caller can prompt", async () => {
    const order: string[] = [];
    await expect(
      installInBackground(
        asUpdate(recordingUpdate(order, true)),
        async (holding) => {
          order.push(holding ? "hold" : "release");
        },
        async () => {
          order.push("after");
        },
        () => {},
      ),
    ).rejects.toThrow(/rename failed/);
    expect(order).toEqual(["download", "hold", "install", "release"]);
  });

  it("takes no hold when the download fails", async () => {
    const hold = vi.fn(async () => {});
    const update = recordingUpdate([]);
    update.download.mockRejectedValueOnce(new Error("signature mismatch"));
    await expect(
      installInBackground(asUpdate(update), hold, async () => {}, () => {}),
    ).rejects.toThrow(/signature/);
    expect(hold).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
  });

  it("is still an install when the collector restart throws", async () => {
    const lines: string[] = [];
    await expect(
      installInBackground(
        asUpdate(recordingUpdate([])),
        async () => {},
        async () => {
          throw new Error("launchctl missing");
        },
        (line) => lines.push(line),
      ),
    ).resolves.toBeUndefined();
    expect(lines.at(-1)).toBe("After the install: launchctl missing");
  });
});

describe("describeRestart", () => {
  it("says the collector restarted, or why it did not", () => {
    expect(describeRestart({ ok: true, outcome: "restarted" })).toBe(
      "Restarted the collector on the new build.",
    );
    expect(
      describeRestart({ ok: false, error: "kickstart failed" }),
    ).toContain("runs the old build until you sign out or run tacho enroll");
  });

  it("says nothing when there was no collector to restart", () => {
    expect(describeRestart({ ok: true, outcome: "not_running" })).toBeNull();
    expect(describeRestart({ ok: true, outcome: "unsupported" })).toBeNull();
  });
});
