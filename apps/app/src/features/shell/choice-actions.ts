"use server";
// The lists a record picker (`@/ui/record-picker`) offers, one read per kind of
// record. A form that asks for a tool, an agent, a run, a member or a model
// calls one of these the first time its picker opens, so a person picks the
// record by name and the form still sends the id or pattern it always sent.
//
// A cursor read is walked up to a bound and no further: a picker is for
// finding a record, not for loading a registry. Past the bound the answer is
// marked partial, and the picker says so and keeps accepting typed text where
// the field takes patterns.
import { APPROVER_ROLES } from "@/data/contracts/mandates";
import { dataSource } from "@/data/source";
import type { Read } from "@/data/read";
import type { ActionResult } from "@/server/kernel";
import { readToActionResult } from "@/server/kernel";
import { requireViewer, type WsCtx } from "@/server/viewer";
import type { OptionPage, PickerOption } from "@/ui/record-picker";

// What every list here answers is INV-19's `ActionResult`, the one shape a
// Server Action returns. A picker reads only `ok`, and `OptionLoad` in
// `@/ui/record-picker` is the structural half it takes, so a refusal keeps its
// reason for the next reader without the picker having to know one.
//
// Each action spells `Promise<ActionResult<OptionPage>>` out rather than
// sharing an alias for it. actions.test.ts reads the annotation as written,
// not as resolved, so an alias is invisible to it and the module fails the
// INV-19 check with six `return-type:` violations while being correct.

/** The most cursor pages one list reads before it stops and says it is partial. */
const PAGE_BOUND = 10;
/** Runs change fastest and matter most when recent, so fewer pages are read. */
const RUN_PAGE_BOUND = 3;

type Paged<T> = { items: readonly T[]; nextCursor: string | null };

/**
 * Walk a cursor read up to `bound` pages; a failed page fails the whole list
 * and carries that page's own refusal out, so the caller answers with the
 * reason the store gave rather than a bare no.
 */
async function walk<T>(
  bound: number,
  page: (cursor: string | null) => Promise<Read<Paged<T>>>,
): Promise<
  { ok: true; items: T[]; partial: boolean } | { ok: false; read: Read<never> }
> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < bound; i += 1) {
    const read = await page(cursor);
    if (!read.ok) return { ok: false, read };
    items.push(...read.value.items);
    cursor = read.value.nextCursor;
    if (cursor === null) return { ok: true, items, partial: false };
  }
  return { ok: true, items, partial: true };
}

function loaded(
  options: PickerOption[],
  partial = false,
): ActionResult<OptionPage> {
  return { ok: true, value: { options, partial } };
}

/**
 * Tool patterns over `slug@version`: every version of a tool as `slug@*`, then
 * each version on its own. A mandate, a rule and a definition all match these.
 */
export async function chooseToolPatterns(
  org: string,
  ws: string,
): Promise<ActionResult<OptionPage>> {
  const ctx = await requireViewer(org, ws);
  const list = await walk(PAGE_BOUND, (cursor) =>
    dataSource().tools.versions(ctx, { category: null, cursor }),
  );
  if (!list.ok) return readToActionResult<OptionPage>(list.read);
  const every = new Map<string, PickerOption>();
  const each: PickerOption[] = [];
  for (const version of list.items) {
    const pattern = `${version.slug}@*`;
    if (!every.has(pattern))
      every.set(pattern, {
        value: pattern,
        label: pattern,
        detail: version.name,
      });
    const exact = `${version.slug}@${String(version.version)}`;
    each.push({ value: exact, label: exact, detail: version.name });
  }
  return loaded([...every.values(), ...each], list.partial);
}

/** Who may answer a parked call: the four approver roles, then every member. */
export async function chooseApprovers(
  org: string,
): Promise<ActionResult<OptionPage>> {
  const ctx = await requireViewer(org);
  const read = await dataSource().org.members(ctx);
  if (!read.ok) return readToActionResult<OptionPage>(read);
  return loaded([
    ...APPROVER_ROLES.map((role) => ({
      value: `role:${role}`,
      label: `role:${role}`,
    })),
    ...read.value.members.map((member) => ({
      value: `user:${member.id}`,
      label: member.name ?? member.email,
      detail: member.email,
    })),
  ]);
}

async function agentOptions(ctx: WsCtx): Promise<ActionResult<OptionPage>> {
  const list = await walk(PAGE_BOUND, async (cursor) => {
    const read = await dataSource().agents.list(ctx, { cursor });
    return read.ok
      ? {
          ok: true,
          value: {
            items: read.value.agents,
            nextCursor: read.value.nextCursor,
          },
        }
      : read;
  });
  if (!list.ok) return readToActionResult<OptionPage>(list.read);
  return loaded(
    list.items
      .filter((agent) => agent.status !== "retired")
      .map((agent) => ({
        value: agent.id,
        label: agent.name,
        detail: agent.slug,
      })),
    list.partial,
  );
}

/** The workspace's agents by `agt_…` id; a retired identity is never offered. */
export async function chooseAgents(
  org: string,
  ws: string,
): Promise<ActionResult<OptionPage>> {
  return agentOptions(await requireViewer(org, ws));
}

/**
 * Recent runs by id, labelled with the name `summarize_run` gave them.
 *
 * @deregistered Retained with the replay UI under ADR-130.
 */
export async function chooseRuns(
  org: string,
  ws: string,
): Promise<ActionResult<OptionPage>> {
  const ctx = await requireViewer(org, ws);
  const list = await walk(RUN_PAGE_BOUND, async (cursor) => {
    const read = await dataSource().runs.list(ctx, { cursor });
    return read.ok
      ? {
          ok: true,
          value: { items: read.value.runs, nextCursor: read.value.nextCursor },
        }
      : read;
  });
  if (!list.ok) return readToActionResult<OptionPage>(list.read);
  return loaded(
    list.items.map((run) => ({
      value: run.id,
      label: run.name ?? run.agentKey ?? run.id,
      detail: run.id,
    })),
    list.partial,
  );
}

/**
 * The workspace's registered MCP servers by `mcs_…` id. Not exported: its one
 * caller is `chooseSwitchTargets` below, and every export of a `"use server"`
 * module is a server action any client can call.
 */
async function chooseMcpServers(
  org: string,
  ws: string,
): Promise<ActionResult<OptionPage>> {
  const ctx = await requireViewer(org, ws);
  const read = await dataSource().tools.mcpServers(ctx);
  if (!read.ok) return readToActionResult<OptionPage>(read);
  return loaded(
    read.value.servers.map((server) => ({
      value: server.id,
      label: server.name,
      detail: server.endpointUrl,
    })),
  );
}

/**
 * The records a kill switch can name at one level, by public id. `class` and
 * `operator` are answered on the page (the tag list and the member list it
 * already holds), and the two self-targeted levels ask for nothing.
 */
export async function chooseSwitchTargets(
  org: string,
  ws: string,
  kind: "tool_server" | "tool_version" | "connection" | "agent",
): Promise<ActionResult<OptionPage>> {
  if (kind === "tool_server") return chooseMcpServers(org, ws);
  const ctx = await requireViewer(org, ws);
  if (kind === "agent") return agentOptions(ctx);
  if (kind === "connection") {
    const read = await dataSource().tools.connections(ctx, {
      status: null,
      connectorId: null,
    });
    if (!read.ok) return readToActionResult<OptionPage>(read);
    return loaded(
      read.value.connections.map((connection) => ({
        value: connection.id,
        label: connection.displayName,
        detail: connection.connector,
      })),
    );
  }
  const list = await walk(PAGE_BOUND, (cursor) =>
    dataSource().tools.versions(ctx, { category: null, cursor }),
  );
  if (!list.ok) return readToActionResult<OptionPage>(list.read);
  return loaded(
    list.items.map((version) => ({
      value: version.id,
      label: version.name,
      detail: `${version.slug}@${String(version.version)}`,
    })),
    list.partial,
  );
}

/**
 * Model names the gateway may meet: every model the price book prices, under
 * its name and each alias, then the models runs used that the book cannot price.
 */
export async function chooseModels(
  org: string,
  ws: string,
): Promise<ActionResult<OptionPage>> {
  const ctx = await requireViewer(org, ws);
  const [book, unpriced] = await Promise.all([
    dataSource().spend.priceBook(ctx),
    dataSource().spend.unpricedModels(ctx),
  ]);
  if (!book.ok && !unpriced.ok) return readToActionResult<OptionPage>(book);
  const models = new Map<string, PickerOption>();
  const add = (model: string, provider: string | null) => {
    if (!models.has(model))
      models.set(model, {
        value: model,
        label: model,
        ...(provider === null ? {} : { detail: provider }),
      });
  };
  if (book.ok)
    for (const entry of book.value.entries) {
      add(entry.model, entry.provider);
      for (const alias of entry.modelAliases) add(alias, entry.provider);
    }
  if (unpriced.ok)
    for (const entry of unpriced.value.models) add(entry.model, entry.provider);
  // One of the two reads failing leaves the list short, so it says partial.
  return loaded([...models.values()], !book.ok || !unpriced.ok);
}
