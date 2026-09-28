// The seams other work replaces (#4678, "Seams other lanes replace"). Each one
// is typed as the page will use it and answers "not built" or "not recorded"
// until the work behind it lands, so the page draws the state it would draw
// for a real empty answer only when the record says so.
//
//   - readStudioRecord: the server's steering folder and its discovery. Lane
//     M10 (discovery and sync) writes it; null until then.
//   - readFindings: the tool checks on the server's folder. Lane M5 (#4672)
//     owns lint; null, meaning no checks ran, until then.
//   - tryCall and draftDescription: Try it and Draft, which the second PR of
//     this lane backs with capabilities. Try it is metered as a governed
//     action and Draft bills as in-app agent spend, both through the kernel.
//   - saveStudioDraft, getStudioDraft and openStudioReview: Review, lane M11
//     (#4686), whose capabilities save_studio_draft, get_studio_draft and
//     open_studio_review these mirror. Not built until #4688 merges.
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

/** The Studio record. Null until discovery writes one (lane M10). */
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

/** A seam that ran and failed, with the reason to show. */
type Failed = { ok: false; reason: "failed"; message: string };

/**
 * Refused because the stored draft moved on: a save over a newer revision,
 * or a Review of a draft that is stale, imports an unclassified tool or does
 * not compile. The message says which.
 */
type Conflict = { ok: false; reason: "conflict"; message: string };

/** A definition file M11 vendors into the folder. */
type DefinitionFile = { path: string; text: string };

/** The definition a Review vendors (`studioSourceSchema`). */
type StudioDraftSource =
  | {
      type: "mcp";
      /** The lock's source object, parsed; never a JSON string. */
      lockSource: Readonly<Record<string, unknown>>;
      tools: readonly Readonly<Record<string, unknown>>[];
    }
  | {
      type: "openapi";
      files: readonly DefinitionFile[];
      entry: string;
      overlay?: string;
      commit?: string;
    }
  | { type: "graphql"; sdl: string; commit?: string }
  | {
      type: "graphql";
      /** The introspection result, parsed; never a JSON string. */
      introspection: Readonly<Record<string, unknown>>;
    }
  | { type: "grpc"; files: readonly DefinitionFile[]; commit?: string }
  | { type: "grpc"; reflection: readonly string[] };

/**
 * One save of a server's draft (`save_studio_draft`). The ops replace the
 * stored ones. `revision` is the stored revision the draft was built on: 0
 * for a draft never saved, so a save over someone else's is refused with
 * `conflict` rather than overwriting it. The page always sends it, because
 * a save with no revision overwrites whatever is stored.
 *
 * The browser sends neither `serverToml` nor `source`. The definition can
 * run to 25 MiB, so PR2's server action attaches the recorded one whenever
 * sourceRequired (draft.ts) holds, and the page never carries it.
 */
type SaveStudioDraftInput = {
  /** The server's folder name under tools/servers/. */
  server: string;
  /** `mcs_…`, absent for a server that has no registry row yet. */
  serverId?: string;
  ops: readonly DraftOp[];
  serverToml?: string;
  source?: StudioDraftSource;
  revision?: number;
};

/** The draft as stored (`studioDraftSchema`). */
type SavedStudioDraft = {
  server: string;
  serverId: string | null;
  ops: readonly DraftOp[];
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
) => Promise<
  { ok: true; draft: SavedStudioDraft } | Conflict | NotBuilt | Failed
>;

export type GetStudioDraft = (input: {
  server: string;
}) => Promise<
  { ok: true; draft: SavedStudioDraft | null } | NotBuilt | Failed
>;

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
  revision?: number;
}) => Promise<{ ok: true; review: StudioReview } | Conflict | NotBuilt | Failed>;

/** Save the server's draft (lane M11). */
export const saveStudioDraft: SaveStudioDraft = () =>
  Promise.resolve({ ok: false, reason: "not_built", gap: "steeringPr" });

/** Read the server's stored draft, or null when none is stored (lane M11). */
export const getStudioDraft: GetStudioDraft = () =>
  Promise.resolve({ ok: false, reason: "not_built", gap: "steeringPr" });

/**
 * Review: open one steering PR from the stored draft, or add a commit to the
 * one an earlier Review opened (lane M11).
 */
export const openStudioReview: OpenStudioReview = () =>
  Promise.resolve({ ok: false, reason: "not_built", gap: "steeringPr" });
