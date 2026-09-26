// The agents port on the kernel (ARCHITECTURE.md §3.3): the workspace's
// identities (list_agents), one agent (get_agent), its computed toolbelt
// (get_agent_toolbelt) and its incidents (list_incidents), every one a
// noBillingGate read, each mapped into its view model.
import "server-only";
import { agentGet } from "@oxagen/oxagen/contracts/agent.get";
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { agentToolbeltGet } from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  AgentDetail,
  AgentPage,
  IncidentPage,
  Toolbelt,
} from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toAgentDetail,
  toAgentPage,
  toIncidentPage,
  toToolbelt,
} from "./mappers/agents";

/** `list_agents`' largest page (agent.list.ts: limit max 100). */
const LIST_PAGE = 100;

/** The mapped value parsed at the boundary; a record the view refuses is `record_unmappable`, reported once. */
function view<S extends z.ZodType>(
  orgId: string,
  schema: S,
  mapped: z.input<S>,
  read: string,
): Read<z.output<S>> {
  const parsed = schema.safeParse(mapped);
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId,
    context: `${read} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const agents: DataSource["agents"] = {
  async list(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: agentList,
      // The contract's largest page: the list controls search, sort and page
      // over the rows in hand, so the more of the workspace they hold the
      // fewer agents sit behind the cursor. Retired agents come back only
      // when the caller asks for them.
      input: {
        limit: LIST_PAGE,
        includeRetired: q.includeRetired === true,
        ...(q.cursor === null ? {} : { cursor: q.cursor }),
      },
      page: "agents",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, AgentPage, toAgentPage(read.value), "agents.list");
  },
  async get(ctx, agent) {
    const read = await kernelRead(ctx, {
      contract: agentGet,
      input: { agentId: agent },
      page: "agents",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      AgentDetail,
      toAgentDetail(read.value),
      "agents.get",
    );
  },
  async toolbelt(ctx, agent) {
    const read = await kernelRead(ctx, {
      contract: agentToolbeltGet,
      input: { agentId: agent },
      page: "agents",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, Toolbelt, toToolbelt(read.value), "agents.toolbelt");
  },
  async incidents(ctx, agent, q) {
    const read = await kernelRead(ctx, {
      contract: tachoIncidentList,
      input:
        q.cursor === null
          ? { agentId: agent }
          : { agentId: agent, cursor: q.cursor },
      page: "agents",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      IncidentPage,
      toIncidentPage(read.value),
      "agents.incidents",
    );
  },
};
