// The seams other work replaces (#4678, "Seams other lanes replace"). Each one
// is typed as the page will use it and answers "not built" or "not recorded"
// until the work behind it lands, so the page draws the state it would draw
// for a real empty answer only when the record says so.
//
//   - readStudioRecord: the server's steering folder and its discovery. Lane
//     M10 (#4682, PR #4711) discovers the tools, and a later part of this
//     lane joins them to the folder. Null until then.
//   - readFindings: the tool checks on the server's folder. Lane M5 (#4672)
//     owns lint; null, meaning no checks ran, until then.
//   - tryCall and draftDescription: Try it and Draft, which capabilities of
//     their own will back. Try it is metered as a governed action and Draft
//     bills as in-app agent spend, both through the kernel.
//   - SaveStudioDraft, GetStudioDraft and OpenStudioReview: Review, lane M11
//     (#4686), whose capabilities save_studio_draft, get_studio_draft and
//     open_studio_review shipped in #4688. review-calls.ts binds these types
//     to them through this lane's server actions (actions.ts).
//
// A credential never crosses any of these. Try it names an environment and
// the gateway adds the credential after the request is recorded, and a saved
// test loses any credential header before it is staged (draft.ts, scrubTest).
import type {
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import type { WsCtx } from "@/server/viewer";
import type { DraftOp } from "./draft";
import type { StudioGap } from "./gaps";
import type { StudioRecord } from "./model";

/** An answer from a seam whose work has not landed. */
type NotBuilt = { ok: false; reason: "not_built"; gap: StudioGap };

/** A tool check's finding (lint's `Finding`, lane M5). */
export type StudioFinding = {
  /** The check's rule name, such as `missing_classification`. */
  rule: string;
  level: "error" | "warning" | "info";
  /** The tools.toml key, or null for the server as a whole. */
  tool: string | null;
  /** The field at fault, such as `inputSchema.properties.reason.enum`. */
  field: string | null;
  message: string;
  /** The change that clears the finding. */
  fix: string;
};

export type RecordReader = (
  ctx: WsCtx,
  serverId: string,
) => Promise<StudioRecord | null>;

export type FindingsReader = (
  ctx: WsCtx,
  serverId: string,
) => Promise<readonly StudioFinding[] | null>;

/** The Studio record. Null until PR2 of this lane binds M10's discovery. */
export const readStudioRecord: RecordReader = () => Promise.resolve(null);

/** The tool checks on the folder as it stands. Null until lint lands (lane M5). */
export const readFindings: FindingsReader = () => Promise.resolve(null);

/** One Try it call: an imported tool, an environment and the arguments. */
type TryInput = {
  serverId: string;
  tool: string;
  environment: string;
  /** The arguments, parsed from the JSON the person typed. */
  args: Readonly<Record<string, unknown>>;
};

export type TryResult =
  | {
      ok: true;
      /** What went upstream, as built before the gateway added the credential. */
      request: string;
      /** The upstream's answer, unshaped. */
      raw: string;
      /** What the model would receive after tools.toml's shaping. */
      shaped: string;
    }
  | NotBuilt
  /** Policy denied the call or parked it for approval; the call still counts. */
  | { ok: false; reason: "denied"; message: string }
  | { ok: false; reason: "failed"; message: string };

export type TryCall = (input: TryInput) => Promise<TryResult>;

export const tryCall: TryCall = () =>
  Promise.resolve({ ok: false, reason: "not_built", gap: "capability" });

type DraftResult =
  | { ok: true; description: string }
  | NotBuilt
  | { ok: false; reason: "failed"; message: string };

export type DraftDescription = (input: {
  serverId: string;
  tool: string;
}) => Promise<DraftResult>;

/** Draft a description with the in-app agent, billed as in-app agent spend. */
export const draftDescription: DraftDescription = () =>
  Promise.resolve({ ok: false, reason: "not_built", gap: "capability" });

/**
 * A Review call Oxagen refused. The code is the handler's reason for a
 * refusal that names one (`tools_unclassified`, `draft_not_found`), or the
 * kind of refusal otherwise (`denied`, `unavailable`). The tab maps a code it
 * knows to its own copy, because no message text reaches the app.
 */
export type ReviewFailed = { ok: false; reason: "failed"; code: string };

/**
 * Refused because the stored draft moved on (`draft_revision_stale`): a save
 * over a newer revision, or a Review of a revision that is no longer the
 * stored one. The tab reloads the stored draft and stages its edits on top.
 */
type Conflict = { ok: false; reason: "conflict"; code: "draft_revision_stale" };

/**
 * One save of a server's draft (`save_studio_draft`). The ops replace the
 * stored ones. `revision` is the stored revision the draft was built on: 0
 * for a draft never saved, so a save over someone else's is refused with
 * `conflict` rather than overwriting it. The page always sends it, because
 * a save with no revision overwrites whatever is stored.
 *
 * The browser sends neither server.toml nor the definition. The definition
 * can run to 25 MiB, so the server attaches the recorded one once the app
 * can read the discovery record (pending-capabilities.ts).
 */
type SaveStudioDraftInput = {
  /** The server's folder name under tools/servers/. */
  server: string;
  /** `mcs_…`, absent for a server that has no registry row yet. */
  serverId?: string;
  ops: readonly DraftOp[];
  revision: number;
};

/** The draft as stored (`studioDraftSchema`). */
type SavedStudioDraft = {
  server: string;
  serverId: string | null;
  /**
   * The stored edits. Another page, or another version of this one, wrote
   * them, so the tab checks them against its own draft shape before it
   * stages anything on top (draft.ts, readDraftOps).
   */
  ops: readonly unknown[];
  serverToml: string | null;
  /** The vendored definition's type and size; null when none is attached. */
  source: {
    type: "mcp" | "openapi" | "graphql" | "grpc";
    bytes: number;
  } | null;
  /** Rises by one on every save. */
  revision: number;
  /** The steering PR Review opened from this draft, or null before Review. */
  pr: { number: number; url: string; branch: string } | null;
  updatedAt: string;
};

export type SaveStudioDraft = (
  input: SaveStudioDraftInput,
) => Promise<{ ok: true; draft: SavedStudioDraft } | Conflict | ReviewFailed>;

export type GetStudioDraft = (input: {
  server: string;
}) => Promise<{ ok: true; draft: SavedStudioDraft | null } | ReviewFailed>;

/** A tool's classification before and after a Review. */
type ReviewClassification = {
  risk: ToolRiskGrade;
  sideEffect: ToolSideEffect;
  egress: ToolEgress;
  impacts: readonly string[];
};

/** What one Review opened or updated (`open_studio_review`'s output). */
export type StudioReview = {
  number: number;
  url: string;
  branch: string;
  headSha: string;
  imported: readonly string[];
  removed: readonly string[];
  reclassified: readonly {
    tool: string;
    before: ReviewClassification;
    after: ReviewClassification;
  }[];
  tokens: { definitions: number; budget: number };
  findings: readonly StudioFinding[];
};

export type OpenStudioReview = (input: {
  server: string;
  revision: number;
}) => Promise<{ ok: true; review: StudioReview } | Conflict | ReviewFailed>;
