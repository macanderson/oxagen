/**
 * Background-task lifecycle status, surfaced in the chat BackgroundTaskTray and
 * the inline BackgroundTaskCard (queued/running through the terminal states).
 *
 * Lives in a `.ts` module — not the `.tsx` tray component — so pure type
 * consumers (stream-event-types.ts, and the Playwright e2e specs that import
 * StreamEvent through it) don't drag the React component tree, its JSX, and its
 * `@/`-alias import closure into their typecheck. See apps/app/e2e/tsconfig.json.
 */
export type BackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
