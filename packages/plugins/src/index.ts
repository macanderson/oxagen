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
export {
  GITHUB_MCP_SERVER,
  FIRST_PARTY_MCP_SERVERS,
} from "./first-party-mcp";
export type { FirstPartyMcpServer } from "./first-party-mcp";
