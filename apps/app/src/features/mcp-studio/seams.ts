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
//   - openSteeringPr: Review, lane M11. Not built until then.
//
// A credential never crosses any of these. Try it names an environment and
// the gateway adds the credential after the request is recorded.
import type { WsCtx } from "@/server/viewer";
import type { DraftOp } from "./draft";
import type { StudioGap } from "./gaps";
import type { StudioRecord } from "./model";

/** An answer from a seam whose work has not landed. */
export type NotBuilt = { ok: false; reason: "not_built"; gap: StudioGap };

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
export type TryInput = {
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

export type DraftResult =
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

export type SteeringPrResult =
  | { ok: true; number: number; url: string }
  | NotBuilt
  | { ok: false; reason: "failed"; message: string };

export type OpenSteeringPr = (input: {
  serverId: string;
  ops: readonly DraftOp[];
}) => Promise<SteeringPrResult>;

/** Review: open one steering PR for the server's folder (lane M11). */
export const openSteeringPr: OpenSteeringPr = () =>
  Promise.resolve({ ok: false, reason: "not_built", gap: "steeringPr" });
