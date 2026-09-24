/**
 * The Inngest app id. Inngest prefixes every function id with it, so the id a
 * `inngest/function.failed` event carries is `oxagen-runner-<function id>`.
 * It lives apart from the client so tests that mock `./inngest` still see it.
 */
export const INNGEST_APP_ID = "oxagen-runner";
