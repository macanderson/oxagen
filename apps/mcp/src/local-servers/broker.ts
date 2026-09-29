// broker.ts: the process's one local-gateway broker (mcp-studio-spec, Local
// servers; #4773).
//
// A machine's long-poll and an agent's call to that machine meet in this
// broker, so both must reach the same process. Production runs the MCP
// service as one container on one node (infra/tools/node), and
// tools/scripts/mcp-single-instance.test.ts fails when that changes. A
// second instance would need a shared queue before it could carry local
// calls: until then a call on one instance reads "disconnected" while the
// machine polls the other.
import { createInProcessBroker, type LocalGatewayBroker } from "@oxagen/handlers/mcp-studio/local-calls/broker";

let broker: LocalGatewayBroker | undefined;

/** The process's broker, built on first use. */
export function localGatewayBroker(): LocalGatewayBroker {
  broker ??= createInProcessBroker();
  return broker;
}
