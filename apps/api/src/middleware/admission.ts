import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { createRequestWork } from "@oxagen/config/request-work";
import { ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS } from "@oxagen/oxagen/contracts/assistant.attachment.upload";
import {
  API_ADMISSION_LANES,
  createRequestAdmission,
} from "@oxagen/telemetry/request-admission";
import type { AppEnv } from "../app";

export const apiAdmission = createRequestAdmission(API_ADMISSION_LANES);

export function apiAdmissionLane(path: string): keyof typeof API_ADMISSION_LANES {
  if (
    path.endsWith("/assistant/attachments/upload") ||
    path.endsWith("/asset/upload")
  ) return "upload";
  if (path === "/api/inngest") return "background";
  if (path === "/v1/tacho/events" || path === "/v1/telemetry/stella/operational")
    return "ingest";
  if (/^\/v1\/tacho\/(commands|bundle|heartbeat)(?:\/|$)/.test(path))
    return "control";
  return "interactive";
}

/** Count actual bytes before any parser or handler retains the request body. */
async function boundedRequest(request: Request, maxBytes: number): Promise<Request> {
  if (request.body === null) return request;
  const reader = request.body.getReader();
  let bytes = Buffer.alloc(0);
  let size = 0;
  try {
    if (Number(request.headers.get("content-length")) > maxBytes)
      throw new HTTPException(413, { message: "Payload Too Large" });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - size)
        throw new HTTPException(413, { message: "Payload Too Large" });
      const needed = size + value.byteLength;
      if (needed > bytes.byteLength) {
        // A growing buffer also bounds metadata for millions of tiny chunks.
        const capacity = Math.min(maxBytes, Math.max(64 * 1024, needed, bytes.byteLength * 2));
        const grown = Buffer.allocUnsafe(capacity);
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(value, size);
      size = needed;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const headers = new Headers(request.headers);
  headers.set("content-length", String(size));
  headers.delete("transfer-encoding");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (size > 0) controller.enqueue(bytes.subarray(0, size));
      controller.close();
    },
  });
  return new Request(request, { headers, body, duplex: "half" } as RequestInit & { duplex: "half" });
}

/** Admission precedes authentication, JSON parsing, and store calls. */
export function createApiRequestAdmission(admission = apiAdmission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/health/ready" || c.req.method === "OPTIONS")
      return next();
    const release = admission.acquire(apiAdmissionLane(c.req.path));
    if (release === null) {
      c.header("Retry-After", "2");
      return c.json({
        error: { code: "service_overloaded", message: "The service is at capacity. Retry after 2 seconds." },
        requestId: c.get("requestId"),
      }, 503);
    }
    const work = createRequestWork(release);
    try {
      const maxBytes = c.req.path.endsWith("/assistant/attachments/upload")
        ? ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS + 16 * 1024
        : 4 * 1024 * 1024;
      c.req.raw = await boundedRequest(c.req.raw, maxBytes);
      await work.run(next);
      // Detached kernel calls keep their lease after the response closes.
      const body = c.res.body;
      if (body === null) {
        work.close();
        return;
      }
      const reader = body.getReader();
      let finished = false;
      let cancelling = false;
      function close() {
        if (finished) return;
        finished = true;
        reader.releaseLock();
        work.close();
      }
      c.res = new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (finished || cancelling) return;
            if (chunk.done) {
              close();
              controller.close();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            close();
            controller.error(error);
          }
        },
        async cancel(reason) {
          cancelling = true;
          try { await reader.cancel(reason); }
          finally { close(); }
        },
      }), c.res);
    } catch (error) {
      work.close();
      throw error;
    }
  };
}

export const requestAdmission = createApiRequestAdmission();
