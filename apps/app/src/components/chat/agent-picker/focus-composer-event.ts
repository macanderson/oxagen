/**
 * focus-composer-event.ts — the window `CustomEvent` name dispatched when a
 * chat_ux_v2 agent pick should move focus into the composer's textarea, so
 * the user can start typing immediately after choosing who to talk to.
 *
 * `agent-picker-panel.tsx` dispatches it (v2 apply path); `message-composer.tsx`
 * listens for it (v2 only) and focuses its own `content` textarea. Window-
 * scoped, mirroring the existing `"oxagen:open-conversations"` convention
 * (see `chat-header-mobile.tsx`) rather than threading an imperative ref
 * through the gallery → shell → composer chain.
 */
export const FOCUS_COMPOSER_EVENT = "oxagen:focus-composer";
