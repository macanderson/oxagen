export class ResponseBodyTooLargeError extends Error {
  override readonly name = "ResponseBodyTooLargeError";

  constructor(readonly maxBytes: number) {
    super(`Response body exceeds the ${maxBytes}-byte limit`);
  }
}

/** Count actual response bytes and cancel before buffering beyond the limit. */
export async function readResponseBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("Response byte limit must be a nonnegative safe integer");
  if (response.body === null) {
    signal?.throwIfAborted();
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  let bytes = Buffer.alloc(0);
  let size = 0;
  const abortRead = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", abortRead, { once: true });
  try {
    signal?.throwIfAborted();
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new ResponseBodyTooLargeError(maxBytes);
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > maxBytes - size)
        throw new ResponseBodyTooLargeError(maxBytes);
      const needed = size + value.byteLength;
      if (needed > bytes.byteLength) {
        // One growing buffer bounds metadata even for one-byte chunks.
        const capacity = Math.min(maxBytes, Math.max(64 * 1024, needed, bytes.byteLength * 2));
        const grown = Buffer.allocUnsafe(capacity);
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(value, size);
      size = needed;
    }
    return bytes.subarray(0, size);
  } catch (error) {
    // A source's cancellation hook must not extend the download deadline.
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }
}
