/**
 * The daemon's `send` for the memory reader: one POST per memory to the
 * control plane's `/v1/tacho/memories`, authenticated by the host API key,
 * the way the GitHub broker mints a token. The body names the host, the
 * harness, the file, and its statement (`ingest_tacho_memories`). The API
 * refuses any other field, so an old collector's extra fields answer 400.
 *
 * Resolving marks the entry sent, and rejecting leaves it for the next scan.
 * A 404 means the API does not take memories yet. It is logged once, and the
 * entries wait. A 400, 413 or 422 refuses this entry and no other, so it is
 * logged and marked sent: sending the same text again would be refused the
 * same way, and the file is sent again once it changes.
 */
import type { FetchLike } from "../../host/control-client";
import type { LocalMemoryEntry } from "./memory-reader";

export const MEMORY_UPLOAD_PATH = "/v1/tacho/memories";

/** How long one upload may take before it is abandoned. */
const MEMORY_UPLOAD_TIMEOUT_MS = 15_000;

/** Answers that refuse one entry's content rather than every upload. */
const ENTRY_REFUSED: ReadonlySet<number> = new Set([400, 413, 422]);

export interface MemoryUploadDeps {
  /** Read at every send, so a renewed key is the one used. */
  host: () => {
    api_url: string;
    api_key: string;
    host_enrollment_id: string;
  };
  fetch: FetchLike;
  log: (line: string) => void;
  timeoutMs?: number;
}

export function createMemoryUpload(
  deps: MemoryUploadDeps,
): (entry: LocalMemoryEntry) => Promise<void> {
  let routeMissingLogged = false;
  // The last failure logged. A failure is logged when it changes, not at
  // every scan, and a success clears it.
  let lastFailure: string | undefined;

  function failure(detail: string): Error {
    if (detail !== lastFailure) {
      lastFailure = detail;
      deps.log(
        `memory upload: ${detail}; local memories wait for the next scan`,
      );
    }
    return new Error(`memory upload: ${detail}`);
  }

  return async (entry) => {
    const host = deps.host();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      deps.timeoutMs ?? MEMORY_UPLOAD_TIMEOUT_MS,
    );
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await deps.fetch(
        `${host.api_url.replace(/\/$/, "")}${MEMORY_UPLOAD_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${host.api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host_enrollment_id: host.host_enrollment_id,
            harness: entry.harness,
            path: entry.path,
            statement: entry.statement,
          }),
          signal: controller.signal,
        },
      );
      // Read to the end, so the connection is free for the next upload.
      await response.text();
    } catch (error) {
      throw failure(
        `the control plane is unreachable (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timer);
    }
    const status = response.status;
    if (response.ok) {
      lastFailure = undefined;
      return;
    }
    if (status === 404) {
      if (!routeMissingLogged) {
        routeMissingLogged = true;
        deps.log(
          `memory upload: the control plane has no ${MEMORY_UPLOAD_PATH} route yet; local memories stay unsent until it does`,
        );
      }
      throw new Error("memory upload: the control plane answered 404");
    }
    if (ENTRY_REFUSED.has(status)) {
      deps.log(
        `memory upload: the control plane refused ${entry.path} (${status}); it is sent again when the file changes`,
      );
      return;
    }
    throw failure(`the control plane answered ${status}`);
  };
}
