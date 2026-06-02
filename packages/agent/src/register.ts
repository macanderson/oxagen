import { registerHandler } from "@oxagen/oxagen/kernel";
import { agentHandlerNames, resolveHandler } from "./handlers/index";

// Side-effect module: binds every agent-runtime handler into the shared
// kernel. Reuses this package's existing lazy `resolveHandler` (which dynamic-
// imports the handler module and picks its export) so there is a single
// resolution path. Import once at boot on any surface that dispatches agent
// capabilities (mcp, the in-app runtime).

for (const name of agentHandlerNames) {
  registerHandler(name, () => resolveHandler(name));
}
