import { describe, expect, it, vi } from "vitest";
import { readResponseBody, ResponseBodyTooLargeError } from "./read-response-body";

describe("bounded response bodies", () => {
  it.each([undefined, "1", "100"])("cancels overflow with declared size %s", async (length) => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(5));
    });
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    const response = new Response(body, {
      headers: length === undefined ? {} : { "content-length": length },
    });
    await expect(readResponseBody(response, 8)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(pull).toHaveBeenCalledTimes(length === "100" ? 0 : 2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("preserves every byte at the exact limit across tiny chunks", async () => {
    let value = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (value === 256) controller.close();
        else controller.enqueue(new Uint8Array([value++]));
      },
    }, { highWaterMark: 0 });
    expect(await readResponseBody(new Response(body), 256))
      .toEqual(Buffer.from(Array.from({ length: 256 }, (_, index) => index)));
    expect(body.locked).toBe(false);
  });

  it.each([true, false])("cancels a stalled read when the signal is already aborted: %s", async (alreadyAborted) => {
    const abort = new AbortController();
    const error = new Error("download expired");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    if (alreadyAborted) abort.abort(error);
    const result = readResponseBody(new Response(body), 100, abort.signal);
    const failed = expect(result).rejects.toBe(error);
    if (!alreadyAborted) abort.abort(error);
    await failed;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("releases the reader after a source error", async () => {
    const error = new Error("source failed");
    const body = new ReadableStream<Uint8Array>({
      pull() { throw error; },
    }, { highWaterMark: 0 });
    await expect(readResponseBody(new Response(body), 100)).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });

  it("rejects non-byte chunks before buffering and cancels the source", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<string>({
      pull(controller) { controller.enqueue("invalid response chunk"); },
      cancel,
    }, { highWaterMark: 0 });
    // A Response takes byte chunks only. This one is handed strings on purpose,
    // to prove the reader refuses them, so the type is widened by hand.
    const mislabelled = body as unknown as ReadableStream<Uint8Array>;
    await expect(readResponseBody(new Response(mislabelled), 100))
      .rejects.toThrow("Response body must contain byte chunks");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("rejects overflow even when source cancellation never completes", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(2)); },
      cancel: () => new Promise<void>(() => undefined),
    }, { highWaterMark: 0 });
    await expect(readResponseBody(new Response(body), 1))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(body.locked).toBe(false);
  });
});
