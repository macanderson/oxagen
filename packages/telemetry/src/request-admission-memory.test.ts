import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("request admission under a constrained heap", () => {
  it("bounds allocated work and recovers across 30 bursts of 500 offers", () => {
    // The subprocess owns a fixed heap independent of Vitest and coverage.
    // This measures admission retention, not fleet throughput or store latency.
    const source = new URL("./request-admission.ts", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      import { createRequestAdmission } from ${JSON.stringify(source)};
      const MiB = 1024 * 1024;
      const gate = createRequestAdmission({ work: { concurrency: 4, reserveBytes: 4 * MiB } });
      let peakActive = 0;
      const settled = [];
      async function burst() {
        const held = [];
        for (let offer = 0; offer < 500; offer++) {
          const release = gate.acquire("work");
          if (release === null) continue;
          held.push({
            release,
            heap: Array.from({ length: 256 * 1024 }, (_, i) => i),
            native: Buffer.alloc(MiB, offer % 256),
          });
          peakActive = Math.max(peakActive, held.length);
        }
        assert.equal(held.length, 4);
        for (const item of held) {
          assert.equal(item.heap[123], 123);
          assert.equal(item.native.byteLength, MiB);
          item.release();
          item.release();
        }
        assert.equal(gate.snapshot().reservedBytes, 0);
        assert.equal(gate.snapshot().active.work, 0);
      }
      for (let cycle = 0; cycle < 30; cycle++) {
        await burst();
        await new Promise(setImmediate);
        global.gc();
        if (cycle >= 5) settled.push(process.memoryUsage());
      }
      const first = settled[0];
      const last = settled.at(-1);
      assert.ok(last.heapUsed <= first.heapUsed + 4 * MiB, "heap remained retained after requests completed");
      assert.ok(last.external <= first.external + 8 * MiB, "native buffers remained retained after requests completed");
      assert.ok(last.rss <= first.rss + 32 * MiB, "resident memory grew across completed bursts");
      const stats = gate.snapshot();
      assert.equal(stats.admitted, 120);
      assert.equal(stats.rejected, 14880);
      console.log(JSON.stringify({ peakActive, admitted: stats.admitted, rejected: stats.rejected,
        settledHeapBytes: last.heapUsed, settledRssBytes: last.rss }));
    `;
    const child = spawnSync(process.execPath, [
      "--expose-gc",
      "--max-old-space-size=64",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script,
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      peakActive: 4,
      admitted: 120,
      rejected: 14_880,
    });
  }, 35_000);
});
