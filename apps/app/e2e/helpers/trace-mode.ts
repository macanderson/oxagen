/**
 * Which Playwright trace mode a run uses, and why the default cannot catch a
 * flake.
 *
 * `on-first-retry` starts tracing at the RETRY. The first attempt — the one
 * that failed — is never recorded. For a deterministic failure that is fine:
 * the retry fails the same way and its trace shows it. For a flake it is
 * exactly backwards, because the retry usually passes, so what gets kept is a
 * trace of a successful run and an `error-context.md` for the failure nobody
 * can see.
 *
 * That is not a hypothesis. The 2026-09-06 nightly (run 34032000612) failed on
 * `account-nav.spec.ts` and the artifact holds one trace for it: the retry's,
 * ending in a screenshot and After Hooks — a pass. #2559 says traces "are now
 * saved automatically on failure"; for the flake it was filed about, they are
 * not.
 *
 * `retain-on-failure` traces every attempt and discards the passing ones, so a
 * flake's first failure is kept. It costs wall clock on every attempt, which is
 * why it is asked for by name rather than made the default: the nightly is
 * where these flakes live and where minutes are cheap; a pull request's e2e run
 * is neither.
 */
export type TraceMode = "on-first-retry" | "retain-on-failure";

/**
 * `PLAYWRIGHT_TRACE_ALL` opts a run into tracing every attempt.
 *
 * Any non-empty value other than "0" or "false" turns it on — a CI `env:` block
 * writes "1", and a value like "false" arriving as a string should not read as
 * true.
 */
export function traceMode(env: NodeJS.ProcessEnv = process.env): TraceMode {
  const raw = env["PLAYWRIGHT_TRACE_ALL"]?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false") return "on-first-retry";
  return "retain-on-failure";
}
