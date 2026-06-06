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
export * from "./registry";
