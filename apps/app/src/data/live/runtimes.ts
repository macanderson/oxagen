// The runtimes port on the kernel (ARCHITECTURE.md §3.3): the workspace's host
// enrollments (`list_tacho_hosts`), the identities they name (`list_agents`),
// and the runtimes the workspace named (`list_runtimes`, ADR-192), each a
// noBillingGate read mapped into its view model.
//
// The first two walk their cursor to the end under a bound. The Runtimes page
// counts what it lists, and one page read as the whole workspace would be a
// figure that reads as a fact; `more` says when the bound stopped the walk.
// `list_runtimes` answers every runtime in one read.
import "server-only";
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { runtimeList } from "@oxagen/oxagen/contracts/runtime.list";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import {
  NamedRuntimeList,
  RuntimeAgents,
  RuntimeList,
} from "@/data/contracts/runtimes";
import { type ContractOutput, kernelRead } from "@/server/kernel";
import {
  toNamedRuntimeList,
  toRuntimeAgent,
  toRuntimeEnrollment,
} from "./mappers/runtimes";

/** 200 enrollments a page, five pages: a thousand enrollments before the page says it stopped. */
const HOST_PAGE = 200;
const HOST_PAGES = 5;
/** 100 identities a page, ten pages. */
const AGENT_PAGE = 100;
const AGENT_PAGES = 10;

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

export const runtimes: DataSource["runtimes"] = {
  async list(ctx) {
    const enrollments: z.input<typeof RuntimeList>["enrollments"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < HOST_PAGES; page++) {
      const read: Read<ContractOutput<typeof tachoHostList>> = await kernelRead(
        ctx,
        {
          contract: tachoHostList,
          input:
            cursor === null
              ? { limit: HOST_PAGE }
              : { limit: HOST_PAGE, cursor },
          page: "runtimes",
        },
      );
      if (!read.ok) return read;
      enrollments.push(...read.value.hosts.map(toRuntimeEnrollment));
      cursor = read.value.nextCursor;
      if (cursor === null) break;
    }
    return view(
      ctx.orgId,
      RuntimeList,
      { enrollments, more: cursor !== null },
      "runtimes.list",
    );
  },
  async agents(ctx, keys) {
    const wanted = new Set(keys);
    const agents: z.input<typeof RuntimeAgents>["agents"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < AGENT_PAGES && wanted.size > 0; page++) {
      const read: Read<ContractOutput<typeof agentList>> = await kernelRead(
        ctx,
        {
          contract: agentList,
          input:
            cursor === null
              ? { limit: AGENT_PAGE }
              : { limit: AGENT_PAGE, cursor },
          page: "runtimes",
        },
      );
      if (!read.ok) return read;
      for (const item of read.value.items) {
        const agent = toRuntimeAgent(item);
        if (agent === null || !wanted.has(agent.agentKey)) continue;
        agents.push(agent);
        wanted.delete(agent.agentKey);
      }
      cursor = read.value.nextCursor;
      if (cursor === null) break;
    }
    return view(ctx.orgId, RuntimeAgents, { agents }, "runtimes.agents");
  },
  async named(ctx) {
    const read = await kernelRead(ctx, {
      contract: runtimeList,
      input: {},
      page: "runtimes",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      NamedRuntimeList,
      toNamedRuntimeList(read.value),
      "runtimes.named",
    );
  },
};
