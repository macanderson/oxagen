// The seams the Studio page reads and writes through (#4678, "Seams other
// lanes replace"). Each is typed as the page uses it, so a test passes a fake.
//
//   - RecordReader: the server's steering folder, read through
//     get_studio_server. record-read.ts binds it, and answers null for a
//     server no steering repo defines.
//   - SaveStudioDraft, GetStudioDraft and OpenStudioReview: Review, lane M11
//     (#4686), whose capabilities save_studio_draft, get_studio_draft and
//     open_studio_review shipped in #4688. review-calls.ts binds these types
//     to them through this lane's server actions (actions.ts).
//
// The Test tab, Draft, the Changes tab's findings, discovery and credential
// writes call their capabilities through studio-calls.ts.
//
// A credential never crosses any of these seams.
import type {
  McpServer,
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import type { WsCtx } from "@/server/viewer";
import type { DraftOp } from "./draft";
import type { StudioRecord } from "./model";

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

/** The Studio record of one registry server, or null when it has none. */
export type RecordReader = (
  ctx: WsCtx,
  server: McpServer,
) => Promise<StudioRecord | null>;

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
 * can run to 25 MiB, so the server attaches the recorded one once the page
 * reads the Studio record (#4678).
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
