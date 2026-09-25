/**
 * What `tacho status` says about shipping. A host that records but never
 * ships is not working, so the verdict must fail loudly rather than trail
 * the error at the end of the daemon line.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { Wal } from "../host/wal";
import { minimalSession } from "../test-helpers";
import type { CliDeps } from "./deps";
import { SHIPPING_STALL_MS, shippingHealth, status } from "./status";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("the shipping verdict", () => {
  it("fails when the daemon does not answer", () => {
    const verdict = shippingHealth(null, { unshipped: 0 }, NOW);
    expect(verdict.healthy).toBe(false);
    expect(verdict.detail).toContain("not answering");
  });

  it("passes with nothing waiting, whatever the last error was", () => {
    expect(
      shippingHealth({ last_error: "old failure" }, { unshipped: 0 }, NOW)
        .healthy,
    ).toBe(true);
  });

  it("fails for a revoked host even with nothing waiting (#3944, S-04)", () => {
    // The shipper stopped for good, so a WAL that happens to be empty now
    // must not read as shipping.
    const verdict = shippingHealth(
      {
        host_status: "revoked",
        last_error: "an operator revoked this host's enrollment",
        last_ingest_at: ago(1_000),
      },
      { unshipped: 0 },
      NOW,
    );
    expect(verdict.healthy).toBe(false);
    expect(verdict.detail).toContain("revoked");
    expect(
      shippingHealth(
        { host_status: "active", last_error: null },
        { unshipped: 0 },
        NOW,
      ).healthy,
    ).toBe(true);
  });

  it("fails with events waiting behind a failed ingest, and names the error", () => {
    const verdict = shippingHealth(
      {
        last_error: "control plane unreachable: This operation was aborted",
        last_ingest_at: ago(1_000),
      },
      { unshipped: 2296, oldestUnshippedAt: ago(1_000) },
      NOW,
    );
    expect(verdict.healthy).toBe(false);
    expect(verdict.detail).toContain("2296 events waiting");
    expect(verdict.detail).toContain("This operation was aborted");
  });

  it("fails when an old backlog sits and nothing has shipped for the stall window", () => {
    const stale = ago(SHIPPING_STALL_MS + 1_000);
    expect(
      shippingHealth(
        { last_error: null, last_ingest_at: stale },
        { unshipped: 5, oldestUnshippedAt: stale },
        NOW,
      ),
    ).toEqual({
      healthy: false,
      detail: "nothing has shipped in over 10 minutes, 5 events waiting",
    });
    expect(
      shippingHealth(
        { last_error: null, last_ingest_at: null },
        { unshipped: 1, oldestUnshippedAt: stale },
        NOW,
      ).healthy,
    ).toBe(false);
  });

  it("passes while a backlog drains, and while new events wait their first tick", () => {
    expect(
      shippingHealth(
        { last_error: null, last_ingest_at: ago(2_000) },
        { unshipped: 1621, oldestUnshippedAt: ago(86_400_000) },
        NOW,
      ),
    ).toEqual({ healthy: true, detail: "shipping, 1621 events waiting" });
    expect(
      shippingHealth(
        { last_error: null, last_ingest_at: null },
        { unshipped: 1, oldestUnshippedAt: ago(5_000) },
        NOW,
      ).healthy,
    ).toBe(true);
  });
});

/**
 * An enrolled host whose daemon answers `/status` with `daemon`, and whose
 * WAL holds one unshipped session. Only the members `status()` reads.
 */
function enrolledHost(daemon: Record<string, unknown>): {
  deps: CliDeps;
  lines: string[];
} {
  const paths = scratchPaths();
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle())),
  );
  new Wal(paths.wal).append(minimalSession());
  const lines: string[] = [];
  const deps = {
    paths,
    home: join(paths.root, ".."),
    now: () => NOW,
    out: (line: string) => lines.push(line),
    serviceManager: {
      kind: "launchd",
      unitPath: join(paths.root, "unit.plist"),
      install: () => undefined,
      uninstall: () => undefined,
      status: () => ({ installed: true, running: true }),
    },
    daemonGet: async () => daemon,
    readSettings: () => undefined,
    readCodexHooks: () => undefined,
    readCursorHooks: () => undefined,
    readStellaHooks: () => undefined,
    readClaudeDesktopConfig: () => undefined,
  } as unknown as CliDeps;
  return { deps, lines };
}

describe("the shipping line", () => {
  it("reports FAILING, and says why, when events wait behind a failed ingest", async () => {
    const { deps, lines } = enrolledHost({
      uptime_s: 5,
      last_ingest_at: ago(1_000),
      last_error: "control plane unreachable: This operation was aborted",
    });
    const report = await status({}, deps);
    expect(report.wal?.unshipped).toBeGreaterThan(0);
    expect(report.shipping?.healthy).toBe(false);
    const line = lines.find((l) => l.startsWith("Shipping    "));
    expect(line).toMatch(/^Shipping {4}FAILING: the last ingest failed/);
    expect(line).toContain("This operation was aborted");
  });

  it("reports ok while the same backlog drains with no error", async () => {
    const { deps, lines } = enrolledHost({
      uptime_s: 5,
      last_ingest_at: ago(1_000),
      last_error: null,
    });
    const report = await status({}, deps);
    expect(report.shipping?.healthy).toBe(true);
    expect(lines.find((l) => l.startsWith("Shipping    "))).toMatch(
      /^Shipping {4}ok: shipping, \d+ events? waiting$/,
    );
  });
});
