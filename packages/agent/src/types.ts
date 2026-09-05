// Re-exports @oxagen/oxagen's CapabilityContext. This used to be a
// hand-copied structural twin, kept matching by a "KEEP IN SYNC" comment and
// nothing else — nothing enforced it, and it drifted (#2614): a field added
// to the real type broke type-checks in a handler that never touched either
// file, instead of failing where the field was added.
//
// The mirror existed to dodge a *value* import — `@oxagen/oxagen`'s entry
// point runs `import "./contracts.generated"` at load time, and this
// package (`@oxagen/agent`) already depends on `@oxagen/oxagen`
// (package.json), so a real import was always allowed; what had to be
// avoided was pulling that side-effecting module graph into every file that
// needs this one type. `export type` never emits JS, so it adds no runtime
// edge at all — the same reasoning under which `AgentRunIAMContext` and
// `DeployedAgentInvocationContext`, two kernel-minted security types this
// package also uses, were always imported directly from
// `@oxagen/oxagen`/`@oxagen/oxagen/iam` rather than mirrored.
export type { CapabilityContext } from "@oxagen/oxagen";
