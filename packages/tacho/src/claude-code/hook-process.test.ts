/**
 * `readStdin`'s size cap and deadline (item 14): a hook process used to read
 * stdin with neither, so a harness that never closed the pipe, or a runaway
 * payload, held the process open indefinitely instead of answering within
 * its own budget.
 */
import { describe, expect, it } from "vitest";
import { MAX_HOOK_STDIN_BYTES, readStdin } from "./hook-process";

/** An async-iterable Buffer source `readStdin` can read and destroy. */
interface FakeSource {
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
  destroy(): void;
  destroyed: boolean;
}

function sourceOf(chunks: string[]): FakeSource {
  async function* gen(): AsyncGenerator<Buffer> {
    for (const chunk of chunks) yield Buffer.from(chunk);
  }
  const iterator = gen();
  const source: FakeSource = {
    [Symbol.asyncIterator]: () => iterator,
    destroyed: false,
    destroy() {
      source.destroyed = true;
    },
  };
  return source;
}

/** A source that yields once and then never resolves again, like a pipe the harness never closes. */
function stallingSource(first: string): FakeSource {
  async function* gen(): AsyncGenerator<Buffer> {
    yield Buffer.from(first);
    await new Promise<never>(() => {
      // Never settles: this is the process stdin never closing.
    });
  }
  const iterator = gen();
  const source: FakeSource = {
    [Symbol.asyncIterator]: () => iterator,
    destroyed: false,
    destroy() {
      source.destroyed = true;
    },
  };
  return source;
}

describe("readStdin", () => {
  it("returns the full payload when the stream ends within budget", async () => {
    const result = await readStdin(
      sourceOf(["hello ", "world"]),
      5_000,
      1_000_000,
    );
    expect(result).toEqual({ text: "hello world", truncated: false });
  });

  it("exports a generous default size cap", () => {
    expect(MAX_HOOK_STDIN_BYTES).toBeGreaterThan(1_000_000);
  });

  it("stops at the size cap, keeps what fit, and reports truncated", async () => {
    const result = await readStdin(
      sourceOf(["a".repeat(10), "b".repeat(10), "c".repeat(10)]),
      5_000,
      15,
    );
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a".repeat(10));
  });

  it("stops waiting past its deadline, destroys the source, and still answers from what arrived", async () => {
    const source = stallingSource("partial");
    const result = await readStdin(source, 20, 1_000_000);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("partial");
    expect(source.destroyed).toBe(true);
  });

  it("does not report truncated for a normal read even though the deadline timer was armed", async () => {
    const result = await readStdin(sourceOf(["{}"]), 5_000, 1_000_000);
    expect(result.truncated).toBe(false);
  });
});
