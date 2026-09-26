// Class recipes the Account and Avatar dialogs share (mockup `.field`, `.kv`,
// `.note`, `.lst`), so the two read as one surface. The field label, its hint
// and the small button live in @/ui/control-styles, because the avatar editor
// in @/ui draws them too.

export {
  buttonSmall,
  fieldHint as hint,
  fieldLabel,
} from "@/ui/control-styles";

/** A `dl` of label → value pairs, the mockup's `.kv`. */
export const kv =
  "grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 text-[12.5px]";
export const kvTerm = "whitespace-nowrap text-muted-foreground";
export const kvValue = "m-0 min-w-0 font-mono text-xs [overflow-wrap:anywhere]";

/** A bordered stack of rows, the mockup's `.lst` / `.li`. */
export const list =
  "flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border";
export const listRow = "flex items-start gap-2.5 bg-input-bg px-3 py-2.5";
export const listIcon =
  "mt-px grid size-[22px] flex-none place-items-center rounded-md bg-secondary text-muted-foreground";
export const listBody = "flex min-w-0 flex-1 flex-col gap-0.5";
export const listTitle =
  "flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium text-foreground";
export const listText = "text-xs leading-snug text-muted-foreground";
export const listTime =
  "mt-1 flex-none whitespace-nowrap font-mono text-[10px] text-muted-foreground";
