// The creation wizards' open signal (roadmap creation-spec §1). Every entry
// point, ⌘K Create, a page's own button such as Steering · Skills "Add a
// skill", reaches the one wizard host the workspace layout mounts by
// dispatching this event on `window`. It is a DOM event rather than a React
// context because the entry points live in different features and in the
// shell, and a feature may not import another feature's internals: this module
// is the one both sides are allowed to import.
//
// The kinds are the things an operator creates in Oxagen: each is a file in the
// workspace's main repository, and each wizard ends on a pull request. A kind
// is offered (in the chooser and in ⌘K) once the host carries its wizard; the
// order here is the chooser's order.

/** Every kind the wizard shell is built to host. */
export type CreateKind = "agent" | "tool" | "skill" | "record";

/**
 * The kinds offered today, in the chooser's order. The tool wizard is left
 * out on purpose until its importer and manifest steps are built.
 */
export const CREATE_KINDS: readonly CreateKind[] = ["agent", "skill", "record"];

export const CREATE_EVENT = "oxagen:create";

export type CreatePrefill = { description: string };
// Compatible with the strictest propose_record rationale bound (v2).
export const CREATE_DESCRIPTION_MAX = 1000;
type CreateRequest = {
  kind: CreateKind | null;
  prefill?: CreatePrefill;
  cloneSourceRef?: string;
};

/** Open the chooser (`null`) or one kind's wizard over the current page. */
export function openCreate(
  kind: CreateKind | null = null,
  prefill?: CreatePrefill,
): void {
  window.dispatchEvent(
    new CustomEvent<CreateRequest>(CREATE_EVENT, {
      detail: prefill === undefined ? { kind } : { kind, prefill },
    }),
  );
}

/** Open a manual clone draft from a published source in this workspace. */
export function openClone(
  kind: "agent" | "skill" | "record",
  sourceRef: string,
): void {
  window.dispatchEvent(
    new CustomEvent<CreateRequest>(CREATE_EVENT, {
      detail: { kind, cloneSourceRef: sourceRef },
    }),
  );
}

/** Narrow an event's detail to a request, refusing anything else. */
export function createRequestOf(event: Event): CreateRequest | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null || !("kind" in detail))
    return null;
  const kind: unknown = detail.kind;
  if ("cloneSourceRef" in detail) {
    if (
      (kind !== "agent" && kind !== "skill" && kind !== "record") ||
      typeof detail.cloneSourceRef !== "string" ||
      !detail.cloneSourceRef.trim() ||
      detail.cloneSourceRef.length > 200 ||
      "prefill" in detail
    )
      return null;
    return { kind, cloneSourceRef: detail.cloneSourceRef };
  }
  if ("prefill" in detail) {
    const prefill: unknown = detail.prefill;
    if (
      kind !== "record" ||
      typeof prefill !== "object" ||
      prefill === null ||
      !("description" in prefill) ||
      typeof prefill.description !== "string" ||
      prefill.description.trim().length === 0 ||
      prefill.description.length > CREATE_DESCRIPTION_MAX
    )
      return null;
    return { kind: "record", prefill: { description: prefill.description } };
  }
  if (kind === null) return { kind: null };
  const known = CREATE_KINDS.find((k) => k === kind);
  return known === undefined ? null : { kind: known };
}
