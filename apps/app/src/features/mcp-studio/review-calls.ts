// The Changes tab's Review calls (#4678, item 6): the seams in seams.ts bound
// to lane M11's capabilities through this lane's server actions (actions.ts).
// Each call maps the action's result to the seam's, so the tab reads one code
// per refusal and never a message.
//
// A stale revision is the one refusal the tab handles by reloading, on a save
// or on a Review, so it alone reads as `conflict`. Every other refusal reads
// as `failed` with the handler's reason, or with the kind of refusal when the
// handler named none.
//
// newServerCalls are Add server's: the save of a server that has no folder
// yet, then Review. The first save is at revision 0, so there a stale
// revision means a draft of that name is already stored, which the dialog
// names rather than reloads. When Review refuses, a retry saves again at the
// revision the first save returned. A stale revision then means someone else
// saved that draft since, which the dialog names too.
import type { StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import type { ActionResult } from "@/server/kernel";
import {
  getStudioDraftAction,
  openStudioReviewAction,
  saveNewStudioServerAction,
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

/** A refused action: every ActionResult arm but the answer. */
export type Refused = Exclude<ActionResult<unknown>, { ok: true }>;

const STALE = "draft_revision_stale";

/** A refusal's code: the handler's reason where it names one, else the kind. */
export function codeOf(result: Refused): string {
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

/** A new server as Add server saves it: its server.toml and its definition. */
export type NewStudioServer = {
  server: string;
  serverToml: string;
  source: StudioSource;
};

/** A new server's stored draft: where Review opens and a retry saves again. */
export type SavedStudioServer = { serverId: string | null; revision: number };

/**
 * Save a new server's draft. With `saved` null it is the first save, at
 * revision 0. With `saved` set it is a retry after a refused Review, at the
 * revision that save returned.
 */
export type CreateStudioServer = (
  input: NewStudioServer,
  saved: SavedStudioServer | null,
) => Promise<
  | ({ ok: true } & SavedStudioServer)
  /** The first save found a draft of that name already stored. */
  | { ok: false; reason: "exists" }
  /** A retry found the stored draft saved again by someone else. */
  | { ok: false; reason: "moved" }
  | ReviewFailed
>;

/** Add server's calls for one workspace: the save, then Review. */
export function newServerCalls(at: StudioAt): {
  create: CreateStudioServer;
  review: OpenStudioReview;
} {
  return {
    create: async (input, saved) => {
      const draft = {
        ...input,
        ...(saved === null || saved.serverId === null
          ? {}
          : { serverId: saved.serverId }),
        revision: saved === null ? 0 : saved.revision,
      };
      if (UTF8.encode(JSON.stringify(draft)).length > SAVE_BODY_MAX) {
        return failed("too_large");
      }
      const result = await saveNewStudioServerAction(at.org, at.ws, draft);
      if (result.ok) {
        return {
          ok: true,
          serverId: result.value.serverId,
          revision: result.value.revision,
        };
      }
      const code = codeOf(result);
      if (code !== STALE) return failed(code);
      return saved === null
        ? { ok: false, reason: "exists" }
        : { ok: false, reason: "moved" };
    },
    review: reviewCalls(at).open,
  };
}
