// Class recipes shared by the sign-in and onboarding screens. House tokens only
// (packages/ui globals.css component tokens), so a reskin in the kit reaches here.
// Promote: these become lane L2's Button/Input primitives in src/ui.

export const buttonBase =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "disabled:cursor-not-allowed disabled:bg-button-disabled-bg disabled:text-muted-foreground aria-disabled:cursor-not-allowed";

export const buttonPrimary = `${buttonBase} border border-button-primary-border bg-button-primary-bg text-button-primary-fg hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg`;

export const buttonSecondary = `${buttonBase} border border-button-default-border bg-button-default-bg text-button-default-fg hover:bg-button-default-hover-bg active:bg-button-default-active-bg`;

export const buttonDanger = `${buttonBase} border border-destructive bg-transparent text-destructive hover:bg-destructive hover:text-destructive-foreground`;

export const linkText =
  "font-medium text-link underline-offset-4 hover:text-link-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

export const inputBase =
  "block w-full min-w-0 rounded-md border border-input-border bg-input-bg px-3 py-2.5 text-sm text-input-fg placeholder:text-input-placeholder " +
  "hover:border-input-border-hover focus-visible:border-input-border-focus focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-input-ring " +
  "disabled:bg-input-disabled-bg disabled:text-input-disabled-fg aria-invalid:border-input-invalid-border aria-invalid:outline-input-invalid-ring";

export const panel =
  "rounded-xl border border-border bg-card text-card-foreground shadow-sm";

export const eyebrow =
  "text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground";

export const mono = "font-mono text-[0.92em]";
