// @oxagen/plugins — installable-plugin spine.
// Plan 1 ships the credential service; the PluginType spine lands in Plan 3.
export {
  encryptCredentialSecrets,
  decryptCredentialSecrets,
  MCP_CREDENTIAL_KEY_ID,
} from "./credentials/credential-service";
export type {
  CredentialPlaintext,
  CredentialCiphertext,
  CredentialCiphertextRead,
} from "./credentials/credential-service";
export { resolveCredentialKms } from "./credentials/kms";
export type { ResolvedKms } from "./credentials/kms";
export {
  setWorkspaceSecret,
  getWorkspaceSecret,
} from "./credentials/workspace-credential";
export type {
  SetWorkspaceSecretInput,
  WorkspaceSecret,
} from "./credentials/workspace-credential";
export * from "./registry";
export * from "./oauth";
export {
  listEntitledCapabilityPluginIds,
  capabilityEntitlementGate,
  clearEntitlementCacheForTests,
} from "./entitlements/entitlement-service";
export { bootstrapEntitlementRuntime } from "./entitlements/bootstrap";

// Credential vault + environments (Spec: 2026-06-24-credential-vault-…).
export {
  upsertSecretKey,
  listSecretKeys,
  deleteSecretKey,
  setSecretValue,
  unsetSecretValue,
  importEnv,
  revealSecret,
  exportSecrets,
  resolveEnvironmentSecrets,
} from "./vault/vault-secret-service";
export type {
  VaultActor,
  SecretKeySummary,
  RevealResult,
  ExportResult,
  ImportEnvResult,
  ImportPreviewRow,
  ResolvedSource,
} from "./vault/vault-secret-service";
export { resolveVaultKms, WORKSPACE_VAULT_KEY_ID, VaultLockedError } from "./vault/vault-kms";
export { parseEnvText, isValidSecretKeyName, SECRET_KEY_PATTERN } from "./vault/env-parse";
export type { ParsedEnvEntry } from "./vault/env-parse";
export {
  createEnvironment,
  listEnvironments,
  getEnvironment,
  updateEnvironment,
  deleteEnvironment,
  setDefaultEnvironment,
  isValidEnvironmentSlug,
  ENVIRONMENT_SLUG_PATTERN,
} from "./environments/environment-service";
export type { EnvironmentActor, EnvironmentSummary } from "./environments/environment-service";
