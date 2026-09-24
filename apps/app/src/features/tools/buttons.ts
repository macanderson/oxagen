// The one button the kit has no recipe for: `.btn.danger` (engine.css), a
// destructive action drawn on the panel fill with the error ink and a red
// hairline. The shape is `.btn`'s, so it lines up beside `buttonSecondary`;
// it is never gold, because gold is identity and this is a warning.
export const buttonDanger =
  "inline-flex min-h-8 max-md:min-h-11 items-center justify-center gap-1.5 rounded-[9px] border border-destructive/45 bg-button-default-bg px-[13px] py-1.5 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed";

/** `.btn.ghost`: a cell that opens something, drawn as text until hovered. */
export const buttonGhost =
  "inline-flex min-h-8 max-md:min-h-11 items-center gap-1.5 rounded-[9px] border border-transparent px-2 py-1 text-left text-[13px] font-medium text-foreground transition-colors hover:border-border hover:bg-hl " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
