import { registerHandler, registerHandlersOnce } from "@oxagen/oxagen/kernel";
import { agentHandlerNames, resolveHandler } from "./handlers/index";

// Side-effect module: binds every agent-runtime handler into the shared
// kernel. Reuses this package's existing lazy `resolveHandler` (which dynamic-
// imports the handler module and picks its export) so there is a single
// resolution path. Import once at boot on any surface that dispatches agent
// capabilities (mcp, the in-app runtime).
//
// `registerHandlersOnce` makes a dev-bundler hot-reload re-eval a no-op instead
// of tripping the kernel's duplicate guard.
registerHandlersOnce("@oxagen/agent", () => {
  for (const name of agentHandlerNames) {
    registerHandler(name, () => resolveHandler(name));
  }
});
