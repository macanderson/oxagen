// list_toolbelts and get_toolbelt outputs to the toolbelt view models
// (ARCHITECTURE.md §3.4, ADR-198). Typed from each contract's `_output`.
import type { toolbeltGet } from "@oxagen/oxagen/contracts/toolbelt.get";
import type { toolbeltList } from "@oxagen/oxagen/contracts/toolbelt.list";
import type { z } from "zod";
import type { ToolbeltDetail, ToolbeltList } from "@/data/contracts/toolbelts";
import type { ContractOutput } from "@/server/kernel";

type BeltRefOut = ContractOutput<typeof toolbeltList>["items"][number];

function refOf(ref: Pick<BeltRefOut, "id" | "name" | "slug" | "kind">) {
  return { id: ref.id, name: ref.name, slug: ref.slug, kind: ref.kind };
}

/** The belts with the All tools belt first, whatever order the read answered in. */
export function toToolbeltList(
  out: ContractOutput<typeof toolbeltList>,
): z.input<typeof ToolbeltList> {
  const belts = out.items.map((item) => ({
    ...refOf(item),
    description: item.description,
    clonedFrom: item.clonedFrom === null ? null : refOf(item.clonedFrom),
    tools: item.tools,
    activeTools: item.activeTools,
    servers: item.servers,
    agents: item.agents,
    updatedAt: item.updatedAt,
  }));
  return {
    belts: [
      ...belts.filter((belt) => belt.kind === "all_tools"),
      ...belts.filter((belt) => belt.kind !== "all_tools"),
    ],
    availableTools: out.availableTools,
  };
}

export function toToolbeltDetail(
  out: ContractOutput<typeof toolbeltGet>,
): z.input<typeof ToolbeltDetail> {
  return {
    belt: {
      ...refOf(out.toolbelt),
      description: out.toolbelt.description,
      clonedFrom:
        out.toolbelt.clonedFrom === null
          ? null
          : refOf(out.toolbelt.clonedFrom),
      updatedAt: out.toolbelt.updatedAt,
    },
    groups: out.groups.map((group) => ({
      serverId: group.server.id,
      serverName: group.server.name,
      included: group.included,
      tools: group.tools.map((tool) => ({
        id: tool.id,
        slug: tool.slug,
        name: tool.name,
        description: tool.description,
        available: tool.available,
        defaultActive: tool.defaultActive,
        active: tool.active,
        member: tool.member,
      })),
    })),
    agents: out.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
    })),
  };
}
