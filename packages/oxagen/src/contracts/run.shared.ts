/**
 * The surfaces an in-app agent turn is admitted on (`agent_runs.surface`;
 * `PlatformSurface` in @oxagen/run-ledger). Runs on these surfaces are the
 * assistant's own and stay out of the tenant's run lists.
 *
 * The list lives in a module with no imports. A package that needs only the
 * list, such as @oxagen/rules, then does not load the `list_runs` contract,
 * its schemas, and its registration. `run.list.ts` re-exports it.
 */
export const IN_APP_AGENT_SURFACES = ["chat", "api-chat"] as const;
