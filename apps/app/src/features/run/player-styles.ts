// The frame player bar's button classes, shared by the server-rendered bar
// (`player-bar.tsx`) and its live parts (`frame-player.tsx`). They live in a
// module without "use client" because a server module that reads a string
// from a "use client" module gets a client reference, not the string
// (INV-21, `src/test/arch/client-values.test.ts`).

/**
 * `.fp-bar .btn.sm { padding:3px 8px; font-family:var(--mono);
 * font-size:11.5px; min-width:30px; justify-content:center }` over `.btn.sm`
 * (`border-radius:7px`) and `.btn` (`border:1px solid var(--border);
 * background:var(--panel); font-weight:500`). A phone keeps the 44px target.
 */
export const barShape =
  "inline-flex items-center justify-center rounded-[7px] border border-button-default-border bg-button-default-bg px-2 py-[3px] font-mono text-[11.5px] font-medium text-button-default-fg transition-colors hover:border-rule hover:bg-button-default-hover-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11";
export const barButton = `${barShape} min-w-[30px]`;

/** `.btn:disabled { opacity:.45; cursor:not-allowed }` */
export const disabledStep =
  "cursor-not-allowed opacity-45 hover:bg-button-default-bg";
