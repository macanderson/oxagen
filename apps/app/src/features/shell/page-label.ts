// The label the flyout sends beside the record's id: the name the page gave
// the record it declared with `<PageRecord>` (a run's title, a runtime's
// hostname), so the agent can cite the record the way the person sees it.
//
// The label travels only with the id it names. A page that declared no label,
// a record the flyout read from the path rather than from a declaration, and
// an id the flyout dropped all send none.

/**
 * `ASSISTANT_ENTITY_LABEL_MAX` in `@oxagen/oxagen/contracts/assistant.ask`,
 * written out so the client bundle does not load the contract registry.
 * `assistant-flyout.page-label.test.tsx` holds the two equal.
 *
 * @internal Exported for that test; nothing outside this module imports it.
 */
export const ENTITY_LABEL_MAX = 256;

/**
 * The label to send for `entityId`, or null.
 *
 * A label past the cap is cut with an ellipsis rather than dropped. Three
 * label sources can run past it (a mandate's purpose, the title a harness
 * gives its session, and a ledger run's task reference), and the contract
 * refuses a longer label. Sending one whole would refuse the person's
 * question, and dropping it would lose a name the first 255 characters still
 * carry.
 */
export function labelOnPage(
  declared: { id: string | null; label: string | null } | null,
  entityId: string | null,
): string | null {
  if (declared === null || entityId === null || declared.id !== entityId)
    return null;
  const label = declared.label?.trim() ?? "";
  if (label.length === 0) return null;
  if (label.length <= ENTITY_LABEL_MAX) return label;
  let end = ENTITY_LABEL_MAX - 1;
  // Never between the two halves of a surrogate pair.
  const last = label.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${label.slice(0, end).trimEnd()}…`;
}
