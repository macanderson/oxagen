// The Changes tab's Review calls (#4678, item 6): the seams in seams.ts bound
// to lane M11's capabilities through this lane's server actions (actions.ts).
// Each call maps the action's result to the seam's, so the tab reads one code
// per refusal and never a message.
//
// A stale revision is the one refusal the tab handles by reloading, on a save
// or on a Review, so it alone reads as `conflict`. Every other refusal reads
// as `failed` with the handler's reason, or with the kind of refusal when the
// handler named none.
import type { ActionResult } from "@/server/kernel";
import {
  getStudioDraftAction,
  openStudioReviewAction,
  saveStudioDraftAction,
} from "./actions";
import type { StudioAt } from "./route";
import type {
  GetStudioDraft,
  OpenStudioReview,
  ReviewFailed,
  SaveStudioDraft,
} from "./seams";

/**
 * The most a save may send. Next refuses a server action body over 1 MB
 * (`serverActions.bodySizeLimit`, which next.config leaves at its default),
 * and the body carries the action's other arguments and React's encoding on
 * top of the draft, so the check keeps 64 KiB spare.
 */
const SAVE_BODY_MAX = 1024 * 1024 - 64 * 1024;

const UTF8 = new TextEncoder();

type Refused = Exclude<ActionResult<unknown>, { ok: true }>;

const STALE = "draft_revision_stale";

/** A refusal's code: the handler's reason where it names one, else the kind. */
function codeOf(result: Refused): string {
  switch (result.reason) {
    case "not_found":
    case "conflict":
      return result.code;
    // A denied write carries the role gate's reason, and a denied read the
    // page permission. The tab says the same thing for both.
    case "denied":
    case "invalid":
    case "unavailable":
    case "pending_approval":
    case "exhausted":
      return result.reason;
  }
}

function failed(code: string): ReviewFailed {
  return { ok: false, reason: "failed", code };
}

function refusal(
  result: Refused,
): ReviewFailed | { ok: false; reason: "conflict"; code: typeof STALE } {
  const code = codeOf(result);
  return code === STALE
    ? { ok: false, reason: "conflict", code: STALE }
    : failed(code);
}

/** The Review calls for one workspace. */
export function reviewCalls(at: StudioAt): {
  save: SaveStudioDraft;
  get: GetStudioDraft;
  open: OpenStudioReview;
} {
  return {
    save: async (input) => {
      const draft = {
        server: input.server,
        ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
        ops: input.ops,
        revision: input.revision,
      };
      // Refused here, before the request, so the person reads what to do
      // rather than a transport error.
      if (UTF8.encode(JSON.stringify(draft)).length > SAVE_BODY_MAX) {
        return failed("too_large");
      }
      const result = await saveStudioDraftAction(at.org, at.ws, draft);
      return result.ok ? { ok: true, draft: result.value } : refusal(result);
    },
    get: async ({ server }) => {
      const result = await getStudioDraftAction(at.org, at.ws, server);
      return result.ok
        ? { ok: true, draft: result.value.draft }
        : failed(codeOf(result));
    },
    open: async (input) => {
      const result = await openStudioReviewAction(at.org, at.ws, input);
      return result.ok ? { ok: true, review: result.value } : refusal(result);
    },
  };
}
