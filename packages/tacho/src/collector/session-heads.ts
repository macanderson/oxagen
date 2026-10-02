/**
 * The backfill's pre-flight (ADR-161, spec `backfill.md` section 4): one POST
 * to the control plane's `/v1/tacho/sessions/heads`
 * (`list_tacho_session_heads`) per batch of at most 500 session uuids,
 * authenticated by the host API key. The answer names each session the
 * control plane holds for this host, with how many frames it holds and
 * whether a live session or a backfill wrote them.
 *
 * A pass must not start a chain at seq 0 for a session the control plane
 * already holds: ingest answers that as a chain break. So any failure (an
 * unreachable control plane, an error status, a 404 from a control plane
 * that serves no such route yet, or an answer this host cannot read) answers
 * undefined, and the pass seals nothing it could not check.
 */
import { z } from "zod";
import type { FetchLike } from "../host/control-client";
import type { ServerSessionHead } from "./backfill";

export const SESSION_HEADS_PATH = "/v1/tacho/sessions/heads";

/** How long one batch waits for its answer. */
const SESSION_HEADS_TIMEOUT_MS = 30_000;

const answerSchema = z.object({
  sessions: z.array(
    z.object({
      session_uuid: z.string(),
      seq_count: z.number().int().min(0),
      record_basis: z.enum(["live", "backfill", "mixed"]),
      backfill_normalizer: z.string().nullable(),
    }),
  ),
});

export interface SessionHeadsDeps {
  host: () => {
    api_url: string;
    api_key: string;
    host_enrollment_id: string;
  };
  fetch: FetchLike;
  log: (line: string) => void;
}

export function createSessionHeads(
  deps: SessionHeadsDeps,
): (
  sessionUuids: readonly string[],
) => Promise<ReadonlyMap<string, ServerSessionHead> | undefined> {
  return async (sessionUuids) => {
    const host = deps.host();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_HEADS_TIMEOUT_MS);
    let status: number;
    let text: string;
    try {
      const response = await deps.fetch(
        `${host.api_url.replace(/\/$/, "")}${SESSION_HEADS_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${host.api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host_enrollment_id: host.host_enrollment_id,
            session_uuids: sessionUuids,
          }),
          signal: controller.signal,
        },
      );
      status = response.status;
      text = await response.text();
    } catch (error) {
      deps.log(
        `backfill pre-flight: the control plane did not answer (${error instanceof Error ? error.message : String(error)}); the pass seals nothing it cannot check`,
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }
    if (status < 200 || status >= 300) {
      deps.log(
        `backfill pre-flight: the control plane answered ${status}; the pass seals nothing it cannot check`,
      );
      return undefined;
    }
    let parsed: z.infer<typeof answerSchema>;
    try {
      parsed = answerSchema.parse(JSON.parse(text));
    } catch {
      deps.log(
        "backfill pre-flight: the control plane's answer did not parse; the pass seals nothing it cannot check",
      );
      return undefined;
    }
    const wanted = new Set(sessionUuids);
    const heads = new Map<string, ServerSessionHead>();
    for (const head of parsed.sessions)
      if (wanted.has(head.session_uuid)) heads.set(head.session_uuid, head);
    return heads;
  };
}
