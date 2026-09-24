// The Governed actions tab's two hue families, as token classes (ADR-132).
//
// `.fk-model{--c:var(--fk-model)} .fk-tool{--c:var(--fk-tool)}
// .fk-gov{--c:var(--fk-gov)} .fk-ctx{--c:var(--fk-ctx)}
// .fk-op{--c:var(--fk-op)} .fk-life{--c:var(--muted)}`: what a frame IS, on
// the timeline's ticks and its legend. A categorical family of its own, never
// a state hue and never the gold.
//
// `fpMark`: `policy_decision` `var(--st-allowed)`, `approval_request`
// `var(--st-approval)`, `control.*` `var(--st-proven)`, a tool frame
// `var(--muted)`: how a governed frame WENT, on the list's dot and under the
// scrub. A state hue, so a decision takes the hue of what was decided.
import type { FrameKind, Mark } from "./player-model";

export const KIND_HUE: Record<FrameKind, string> = {
  model: "bg-fk-model",
  tool: "bg-fk-tool",
  gov: "bg-fk-gov",
  ctx: "bg-fk-ctx",
  op: "bg-fk-op",
  life: "bg-muted-foreground",
};

export const MARK_HUE: Record<Mark, string> = {
  allowed: "bg-success",
  approval: "bg-info",
  denied: "bg-warning",
  proven: "bg-proven",
  quiet: "bg-muted-foreground",
};
