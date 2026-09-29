// install.ts: mounts the relay's upgrade listener when the MCP server loads
// (lane M12; ADR-225). middleware.ts imports it for this side effect, because
// xmcp runs no other startup code.
import { installRelayMount } from "./index";

installRelayMount();
