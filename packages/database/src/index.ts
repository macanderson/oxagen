export * from "./client";
export * as schema from "./schema/index";
// Plugin type discriminator — a named export (not just under the `schema`
// namespace) so the agent runtime + handlers can import the union type directly.
export { PLUGIN_TYPES, type PluginType } from "./schema/plugin";
export * as relations from "./relations";
export * from "./types";
export {
  withTenantDb,
  withSystemDb,
  assertRlsConnectionSafe,
  type Tx,
} from "./tenant";
