import { z } from "zod";
import { defineTool } from "./_define";
import { agentMcpList } from "../agent.mcp.list";
import { agentMcpResolve } from "../agent.mcp.resolve";
import { agentMcpConsentList } from "../agent.mcp_consent.list";

const listedServer = agentMcpList.output.shape.servers.element.shape;
const resolvedServer = agentMcpResolve.output.shape.servers.element.shape;

/**
 * Appendix E: `list_tool_servers`. Absorbs `list_mcp_servers`,
 * `resolve_mcp_servers` and `list_mcp_consents`.
 *
 * **The credential fields do not carry, and that is the whole point of this
 * file.** `resolve_mcp_servers` exists to hand the first-party CLI a live
 * bearer token and resolved auth headers for every installed server. §6.7 step
 * 5 replaces that design: the gateway brokers a *per-call* credential, scoped
 * and ledgered in `tools.credential_grants`, and pillar 12 (§6) states flatly
 * that the agent holds no credentials at all. A tool that returns the
 * workspace's whole token set to its caller cannot coexist with either. So
 * `token` and `headers` are dropped, and what survives from `resolve` is the
 * operational half an operator actually reads: which auth scheme a server uses,
 * where the credential came from, and whether it has gone stale.
 *
 * Two consequences of that drop pull in opposite directions, and a reviewer
 * should settle them together rather than one at a time:
 *
 *   - The `agent` surface comes back. `resolve_mcp_servers` was `["api"]` only
 *     *because* it returned secrets; with no secret in the output there is
 *     nothing for an agent to exfiltrate, and §6.6's belt UI needs this list.
 *   - `sensitivity` is nevertheless carried strict at `"high"` from
 *     `resolve_mcp_servers`, per the carry rule. It is arguably re-gradable to
 *     `"medium"` now that the credential fields are gone — the remaining
 *     output is endpoint URLs and re-auth state, which `list_mcp_servers`
 *     already classed `"low"`. **Flagged for the cutover review (#2884); do not
 *     downgrade it silently here.**
 */
export const listToolServers = defineTool({
  name: "list_tool_servers",
  domain: "tools",
  description:
    "List the workspace's registered tool servers with health, transport, tool counts and credential state, plus the tool-consent grants in force. Never returns credentials — the gateway brokers those per call (§6.7).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["list_mcp_servers", "resolve_mcp_servers", "list_mcp_consents"],
  drops: [
    {
      field: "token",
      from: "resolve_mcp_servers",
      why: "a resolved bearer token: §6.7 step 5 brokers a per-call credential recorded in tools.credential_grants, and pillar 12 (§6) holds that the agent never holds one — no read returns live secret material",
    },
    {
      field: "headers",
      from: "resolve_mcp_servers",
      why: "resolved auth headers — same reason as `token`; the gateway builds them at dispatch from tools.connections",
    },
  ],

  // From resolve_mcp_servers, the strictest of the three on both axes: risk
  // "medium" against the other two's "low", and sensitivity "high" against
  // "low". See the doc comment for why the "high" is worth re-examining now
  // that the credential fields are gone.
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "introspection",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * All three handlers were read before declaring this. `agent.mcp.list.ts` and
   * `agent.mcp_consent.list.ts` are plain selects. `agent.mcp.resolve.ts` is
   * the one that had to be checked rather than assumed: it decrypts stored
   * credentials, which sounds like a write, but its own header records that
   * auto-refresh of an expired oauth token is deliberately NOT performed there
   * — it reads, decrypts in memory, and writes nothing back.
   */
  mutates: false,

  input: z.object({
    /**
     * Carried from `list_mcp_consents`. The default (false) is the workspace
     * policy view — which tools *anyone* may invoke without re-prompting —
     * because that is the question the Toolbelt page asks; `true` narrows it to
     * the caller's own grants for the "why was I prompted again" case.
     */
    mineOnly: agentMcpConsentList.input.shape.mineOnly,
  }),

  output: z.object({
    servers: z.array(
      z.object({
        publicId: listedServer.publicId,
        name: listedServer.name,
        transportType: listedServer.transportType,
        endpointUrl: listedServer.endpointUrl,
        healthStatus: listedServer.healthStatus,
        lastHealthcheckAt: listedServer.lastHealthcheckAt,
        toolCount: listedServer.toolCount,

        // Carried from resolve: the scheme and provenance of the credential,
        // never the credential. `authKind` is what tells an operator whether a
        // failing server needs an OAuth hop or a new key.
        authStrategy: resolvedServer.authStrategy,
        authKind: resolvedServer.authKind,

        /**
         * The single most useful field `resolve_mcp_servers` had, and the
         * reason dropping `token` costs nothing operationally: the caller
         * still learns that a server is unusable until someone re-authorises
         * it, which is what `set_connection` is for.
         */
        needsReauth: resolvedServer.needsReauth,
      }),
    ),

    /**
     * Carried wholesale from `list_mcp_consents`. Consents are per (user, tool)
     * rather than per server, so they stay a sibling list rather than being
     * folded into each server row — flattening them would multiply the server
     * rows by their grants and lose the `mineOnly: false` policy view.
     */
    consents: agentMcpConsentList.output.shape.consents,
  }),
});

export type ListToolServersInput = z.output<typeof listToolServers.input>;
export type ListToolServersOutput = z.output<typeof listToolServers.output>;
