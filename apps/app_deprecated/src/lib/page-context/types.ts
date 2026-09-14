/**
 * page-context/types.ts — shared types for the PageContext system.
 *
 * Used by:
 *   - PageContextProvider / usePageContext / useRegisterPageEntity
 *   - AskBar, AskDrawer (consume context)
 *   - downstream shell consumers
 *
 * No runtime code here — types only.
 */

/**
 * Describes the entity the current page is "about".
 * Registered via useRegisterPageEntity so the Ask system can carry
 * rich context into the chat call.
 */
export interface PageEntity {
  /** Semantic kind, e.g. "project", "workspace", "agent", "user". */
  kind: string;
  /** Database / public identifier. */
  id: string;
  /** Human-readable label (e.g. "Production workspace"). */
  label?: string;
  /**
   * One-or-two sentence summary that is appended to the agent system prompt.
   * Keep it ≤200 chars.
   */
  summary?: string;
}

/** The full shape of the PageContext value. */
export interface PageContextValue {
  /** The entity the current page describes, if any. */
  entity: PageEntity | null;

  // Setter used by the registration hook — not for direct consumer use.
  _setEntity: (entity: PageEntity | null) => void;

  /** Ask drawer open state — managed by the provider. */
  isAskOpen: boolean;
  openAsk: () => void;
  closeAsk: () => void;

  /** Command menu open state. */
  isCommandOpen: boolean;
  openCommand: () => void;
  closeCommand: () => void;

  /**
   * Floating wand widget open state.
   * The wand is a global floating chat panel separate from the topbar AskDrawer.
   * Open/close state lives here so any component can toggle it without prop-drilling.
   */
  isWandOpen: boolean;
  openWand: () => void;
  closeWand: () => void;

  /**
   * Pending text to seed into the Ask Drawer's composer input the next time
   * the drawer opens. Consumed (read + cleared) once by the drawer on open.
   *
   * Set via `openAskWithText(text)`. When `autoSubmit` is also true the
   * drawer should submit immediately after seeding.
   */
  pendingAskText: string | null;
  pendingAskAutoSubmit: boolean;
  /**
   * Open the Ask Drawer and pre-fill the composer with `text`.
   * If `autoSubmit` is true the drawer submits the prompt immediately.
   */
  openAskWithText: (text: string, autoSubmit?: boolean) => void;
  /** Clear the pending ask text (called by the drawer after consuming it). */
  _clearPendingAskText: () => void;
}
