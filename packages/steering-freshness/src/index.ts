/**
 * @oxagen/steering-freshness — is this checkout running on the records that
 * are in force?
 *
 * A Context PR merges a record onto the repository's production branch
 * (ADR-061). A developer on a feature branch keeps whatever `.oxagen/` their
 * branch point had, so the longer the branch lives the more likely their
 * agent is steering on records nobody uses any more. This package answers
 * that question, decides what to do about it, and renders the answer for
 * whichever agent is asking.
 *
 * It depends on nothing but git and `zod`. Oxagen governs whatever agent a
 * team already runs, so the one thing this must never grow is a dependency
 * on a particular harness.
 */
export {
  checkSteeringFreshness,
  isStale,
  isSyncSafe,
  steeringPathspec,
  type CheckOptions,
  type FreshnessStatus,
  type FreshnessVerdict,
  type PlatformSignal,
} from "./check";
export {
  evaluateGate,
  type GateAction,
  type GateDecision,
  type GateOptions,
} from "./gate";
export {
  autoSyncActive,
  blockingActive,
  readEmergencyOverride,
  resolveSteeringPolicy,
  steeringPolicyFileSchema,
  ALWAYS_EXCLUDED,
  DEFAULT_POLICY,
  POLICY_SCOPES,
  type PolicyLayer,
  type PolicyScope,
  type SteeringPolicy,
  type SteeringPolicyFile,
} from "./policy";
export {
  loadSteeringSettings,
  LOCAL_SETTINGS_FILE,
  PROJECT_DIR_NAME,
  PROJECT_SETTINGS_FILE,
  USER_SETTINGS_RELATIVE,
  type LoadedSettings,
  type SettingsReadWarning,
} from "./settings";
export {
  syncSteering,
  type SyncOptions,
  type SyncResult,
  type SyncRefusal,
} from "./sync";
export {
  renderBanner,
  renderGate,
  renderJson,
  renderText,
  renderUserPromptSubmit,
  HARNESSES,
  HARNESS_RENDERERS,
  RENDERER_NAMES,
  type RenderedGate,
  type RendererName,
} from "./render";
export {
  hookCommand,
  hookConfigPath,
  hookStatus,
  installHook,
  removeHook,
  HOOK_MARKER,
  HOOK_TIMEOUT_SECONDS,
  INSTALLABLE,
  type InstallableHarness,
  type InstallResult,
} from "./hooks";
export {
  execGit,
  GitCommandError,
  type GitContext,
  type GitRunner,
  type PathChange,
} from "./git";
