/**
 * The daemon's ask for memories at each prompt: one POST to the control
 * plane's `/v1/tacho/memories/recall` (`recall_tacho_memories`),
 * authenticated by the host API key the way the memory upload is. The answer
 * lists the workspace's memories most relevant to the prompt, most relevant
 * first, and the hook hands them to the agent with the prompt. The ask names
 * the session's repository by its remote's digests, and the tools and files
 * the session used, so the control plane can rank the memories scoped to them.
 *
 * The prompt waits for the answer, so the ask gets at most 500 ms
 * (`MEMORY_RECALL_TIMEOUT_MS`). A timeout, an unreachable control plane, an
 * error status, or an answer this collector cannot read each recall nothing,
 * and the prompt goes on without memories. A failure is logged when it
 * changes, not at every prompt. A 404 means the control plane serves no
 * recall yet. It is logged once, and the daemon stops asking for fifteen
 * minutes, so an older control plane costs no prompt a round trip.
 */
import { z } from "zod";
import { isSha256Digest } from "../../digest";
import type { FetchLike } from "../../host/control-client";

export const MEMORY_RECALL_PATH = "/v1/tacho/memories/recall";

/**
 * How long a prompt waits for its memories. The prompt holds its session's
 * hook queue while it waits, so that session's next hooks wait behind a slow
 * answer too. Other sessions' hooks do not (ADR-231).
 */
export const MEMORY_RECALL_TIMEOUT_MS = 500;

/** The most prompt text the route takes (`recall_tacho_memories`). */
export const MEMORY_RECALL_TEXT_MAX_CHARS = 8_000;

/** The most repository digests the route takes. */
export const MEMORY_RECALL_DIGESTS_MAX = 8;

/** The most tool names the route takes. */
export const MEMORY_RECALL_TOOLS_MAX = 64;

/** The longest tool name the route takes. */
export const MEMORY_RECALL_TOOL_MAX_CHARS = 200;

/** The most file paths the route takes. */
export const MEMORY_RECALL_PATHS_MAX = 64;

/** The longest file path the route takes. */
export const MEMORY_RECALL_PATH_MAX_CHARS = 512;

/** How long the daemon stops asking after the control plane answers 404. */
const ROUTE_MISSING_PAUSE_MS = 15 * 60_000;

/** One memory the control plane recalled for a prompt. */
export interface RecalledMemory {
  /** A record's lineage, or a waiting memory's public id. */
  id: string;
  statement: string;
}

export interface MemoryRecallRequest {
  /**
   * The digests of the repository's `origin` remote, as `readRepositoryRemote`
   * reads them (`sha256:<64 hex>`), or none when the daemon does not know the
   * remote. The owner and host stay on the machine. The ask sends at most
   * `MEMORY_RECALL_DIGESTS_MAX`, once each, and drops any other string.
   */
  repositoryDigests: string[];
  /**
   * The tools the session called, most recent first. The ask sends at most
   * `MEMORY_RECALL_TOOLS_MAX`, once each, and drops an empty name or one
   * past `MEMORY_RECALL_TOOL_MAX_CHARS`.
   */
  tools: string[];
  /**
   * The files the session's tools named, relative to the repository root with
   * `/` separators, most recent first. The ask sends at most
   * `MEMORY_RECALL_PATHS_MAX`, once each, and drops an empty path or one
   * past `MEMORY_RECALL_PATH_MAX_CHARS`.
   */
  paths: string[];
  /** The prompt's text. Past `MEMORY_RECALL_TEXT_MAX_CHARS` it is cut. */
  text: string;
}

/** Resolves with the recalled memories, and with none on any failure. */
export type MemoryRecall = (
  request: MemoryRecallRequest,
) => Promise<readonly RecalledMemory[]>;

export interface MemoryRecallDeps {
  /** Read at every ask, so a renewed key is the one used. */
  host: () => {
    api_url: string;
    api_key: string;
    host_enrollment_id: string;
  };
  fetch: FetchLike;
  log: (line: string) => void;
  timeoutMs?: number;
  now?: () => number;
}

// Lenient on purpose: a field a newer control plane adds must not cost the
// prompt its memories.
const recallAnswerSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      statement: z.string(),
    }),
  ),
});

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first `max` UTF-16 units of `text`, never ending on half a pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/**
 * The first `max` distinct entries of `list` that are 1 to `maxChars` long,
 * in their order. The route refuses the whole ask over one entry past its
 * caps, so an entry past them is dropped here rather than sent. A cut name
 * would match no record, so a long entry is dropped, not cut.
 */
function bounded(
  list: readonly string[],
  max: number,
  maxChars: number,
): string[] {
  const kept: string[] = [];
  for (const entry of list) {
    if (kept.length === max) break;
    if (entry.length === 0 || entry.length > maxChars) continue;
    if (!kept.includes(entry)) kept.push(entry);
  }
  return kept;
}

export function createMemoryRecall(deps: MemoryRecallDeps): MemoryRecall {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? MEMORY_RECALL_TIMEOUT_MS;
  let routeMissingLogged = false;
  let pausedUntil = 0;
  // The last failure logged. A failure is logged when it changes, not at
  // every prompt, and a success clears it.
  let lastFailure: string | undefined;

  function failed(detail: string): readonly RecalledMemory[] {
    if (detail !== lastFailure) {
      lastFailure = detail;
      deps.log(
        `memory recall: ${detail}; prompts go on without recalled memories`,
      );
    }
    return [];
  }

  async function ask(
    request: MemoryRecallRequest,
    signal: AbortSignal,
  ): Promise<readonly RecalledMemory[]> {
    const host = deps.host();
    let status: number;
    let ok: boolean;
    let body: string;
    try {
      const response = await deps.fetch(
        `${host.api_url.replace(/\/$/, "")}${MEMORY_RECALL_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${host.api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host_enrollment_id: host.host_enrollment_id,
            repository_digests: bounded(
              request.repositoryDigests.filter(isSha256Digest),
              MEMORY_RECALL_DIGESTS_MAX,
              Number.POSITIVE_INFINITY,
            ),
            tools: bounded(
              request.tools,
              MEMORY_RECALL_TOOLS_MAX,
              MEMORY_RECALL_TOOL_MAX_CHARS,
            ),
            paths: bounded(
              request.paths,
              MEMORY_RECALL_PATHS_MAX,
              MEMORY_RECALL_PATH_MAX_CHARS,
            ),
            text: cut(request.text, MEMORY_RECALL_TEXT_MAX_CHARS),
          }),
          signal,
        },
      );
      status = response.status;
      ok = response.ok;
      body = await response.text();
    } catch (error) {
      // The timeout already answered and logged.
      if (signal.aborted) return [];
      return failed(`the control plane is unreachable (${reason(error)})`);
    }
    if (signal.aborted) return [];
    if (status === 404) {
      pausedUntil = now() + ROUTE_MISSING_PAUSE_MS;
      if (!routeMissingLogged) {
        routeMissingLogged = true;
        deps.log(
          `memory recall: the control plane has no ${MEMORY_RECALL_PATH} route yet; prompts go on without recalled memories, and the daemon asks again every 15 minutes`,
        );
      }
      return [];
    }
    if (!ok) return failed(`the control plane answered ${status}`);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return failed("the control plane's answer is not JSON");
    }
    const parsed = recallAnswerSchema.safeParse(json);
    if (!parsed.success)
      return failed("the control plane's answer is not a list of memories");
    lastFailure = undefined;
    return parsed.data.items.map(({ id, statement }) => ({ id, statement }));
  }

  return async (request) => {
    if (now() < pausedUntil) return [];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<readonly RecalledMemory[]>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(
          failed(`the control plane took longer than ${timeoutMs} ms to answer`),
        );
      }, timeoutMs);
    });
    try {
      const answered = ask(request, controller.signal).catch((error: unknown) =>
        failed(`the ask failed (${reason(error)})`),
      );
      return await Promise.race([answered, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}
