// The pull request links an ingest batch lands, as backfill requests
// (#4129, ADR-189).
//
// A link is the same thing `list_runs` reads from the frames: the `pr.url`
// attr any frame carries, or a pr_link frame's `pr_url` from before #3944.
// Each root session and URL is asked once. Its event id holds for that pair,
// so a re-sent batch or a second frame naming the same link sends nothing
// new, and a lost event leaves the link reading "status unknown" until the
// forge next reports the pull request.
import { createHash } from "node:crypto";
import { RUN_PULL_REQUEST_LINKED_EVENT } from "@oxagen/inngest-functions/events";
import { logger } from "../logger";
import { forgeKeyOf } from "./run-pull-request-state";

/** The fields of an ingest event this reads. */
export type LinkFrame = {
  kind: string;
  root_session_uuid: string;
  attrs: Readonly<Record<string, string>>;
};

export type PullRequestLinkedEvent = {
  name: typeof RUN_PULL_REQUEST_LINKED_EVENT;
  id: string;
  data: {
    orgId: string;
    workspaceId: string;
    rootSessionUuid: string;
    url: string;
  };
};

/** The URL a frame records, the way `prAttr` reads it in ClickHouse. */
function linkOf(frame: LinkFrame): string {
  const dotted = frame.attrs["pr.url"] ?? "";
  if (dotted !== "") return dotted;
  return frame.kind === "oxagen:pr_link" ? (frame.attrs.pr_url ?? "") : "";
}

/**
 * One event per root session and link a batch records. Only a link on a
 * forge Oxagen can connect is asked for: no read could fill any other.
 */
export function pullRequestLinkEvents(
  scope: { orgId: string; workspaceId: string },
  frames: readonly LinkFrame[],
): PullRequestLinkedEvent[] {
  const out = new Map<string, PullRequestLinkedEvent>();
  for (const frame of frames) {
    const url = linkOf(frame);
    if (url === "" || forgeKeyOf(url) === null) continue;
    const digest = createHash("sha256").update(url).digest("hex").slice(0, 32);
    const id = `run-pr-linked:${frame.root_session_uuid}:${digest}`;
    if (out.has(id)) continue;
    out.set(id, {
      name: RUN_PULL_REQUEST_LINKED_EVENT,
      id,
      data: {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        rootSessionUuid: frame.root_session_uuid,
        url,
      },
    });
  }
  return [...out.values()];
}

/**
 * Send the batch's link events. Best effort: a failed send is logged, and the
 * webhooks still fill the state the next time the forge reports it.
 */
export async function sendPullRequestLinks(
  send: (events: PullRequestLinkedEvent[]) => Promise<unknown>,
  scope: { orgId: string; workspaceId: string },
  frames: readonly LinkFrame[],
): Promise<void> {
  const events = pullRequestLinkEvents(scope, frames);
  if (events.length === 0) return;
  try {
    await send(events);
  } catch (err) {
    logger.warn(
      { err, links: events.length },
      "tacho.events.ingest: run/pull-request.linked dispatch failed; the forge's next delivery fills the state",
    );
  }
}
