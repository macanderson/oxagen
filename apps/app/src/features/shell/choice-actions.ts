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
//
// A tool is offered by what a person can judge it by: its vendor's logo and
// name, a title read from its API name, the version a pattern covers, whether
// it writes, and its risk grade. An imported tool's slug is
// `mcp.<server uuid>.<name>`, so the slug is the form's value and never a
// line of the row.
import { getTranslations } from "next-intl/server";
import { APPROVER_ROLES } from "@/data/contracts/mandates";
import type { McpServer, ToolVersion } from "@/data/contracts/tools";
import { dataSource } from "@/data/source";
import type { Read } from "@/data/read";
import type { ActionResult } from "@/server/kernel";
import { readToActionResult } from "@/server/kernel";
import { requireViewer, type WsCtx } from "@/server/viewer";
import type { BadgeTone } from "@/ui/badge";
import type {
  OptionPage,
  PickerFact,
  PickerIcon,
  PickerNamespace,
  PickerOption,
} from "@/ui/record-picker";

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
  namespaces: PickerNamespace[] = [],
): ActionResult<OptionPage> {
  return {
    ok: true,
    value: {
      options,
      partial,
      ...(namespaces.length === 0 ? {} : { namespaces }),
    },
  };
}

// ── Tools ───────────────────────────────────────────────────────────────────

/**
 * The workspace's MCP servers by `mcs_…`, for each tool's vendor name and
 * logo. A refused read leaves the tools without a vendor, not the list
 * unloaded: the tools are still the record a person picks.
 */
async function serversById(ctx: WsCtx): Promise<Map<string, McpServer>> {
  const read = await dataSource().tools.mcpServers(ctx);
  return new Map(read.ok ? read.value.servers.map((s) => [s.id, s]) : []);
}

/** What a tool does to the world: its classification, else what it declares. */
type Effect = "read" | "write" | "irreversible" | "undeclared";

/**
 * A tool row's words, read once per list. Every call to the translator stays
 * here, where it is bound, so the catalogue check (INV-12) can expand each key.
 */
async function toolWords() {
  const t = await getTranslations("shell.choices.tool");
  return {
    source: (source: ToolVersion["source"]) => t(`source.${source}`),
    effect: (effect: Effect) => t(`effect.${effect}`),
    risk: (grade: ToolVersion["riskGrade"]) => t(`risk.${grade}`),
    pinned: (title: string, version: number) =>
      t("pinnedLabel", { title, version }),
    context: (vendor: string, pin: number | null) =>
      t("context", {
        vendor,
        versions:
          pin === null ? t("everyVersion") : t("oneVersion", { version: pin }),
      }),
  };
}
type ToolWords = Awaited<ReturnType<typeof toolWords>>;

const EFFECT_TONE = {
  read: "allowed",
  write: "approval",
  irreversible: "critical",
  undeclared: "denied",
} as const satisfies Record<Effect, BadgeTone>;

const RISK_TONE = {
  low: "quiet",
  medium: "quiet",
  high: "denied",
  critical: "critical",
} as const satisfies Record<ToolVersion["riskGrade"], BadgeTone>;

function effectOf(version: ToolVersion): Effect {
  if (version.classification !== null) return version.classification.sideEffect;
  // Unclassified and not declared read-only: nothing says it cannot write.
  return version.readOnly ? "read" : "undeclared";
}

/**
 * A title from a tool's API name: `notion-create-database` from the Notion
 * server reads "Create database", and `google_drive_list_files` from Google
 * Drive reads "List files". The server's own name is dropped from the front,
 * word by word, since the logo and the context line carry it; at least one
 * word is always kept. `vendor` is the server's name, or null for a tool no
 * server provides. A name that already has spaces is a title and is kept.
 */
function titleOf(name: string, vendor: string | null): string {
  if (/\s/.test(name)) return name;
  let words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((word) => word !== "")
    .map((word) => (/^[A-Z][a-z]/.test(word) ? word.toLowerCase() : word));
  const lead = (vendor ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  let dropped = 0;
  while (
    dropped < lead.length &&
    dropped < words.length - 1 &&
    words[dropped]?.toLowerCase() === lead[dropped]
  )
    dropped += 1;
  words = words.slice(dropped);
  const text = words.join(" ");
  return text === "" ? name : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who provides a tool: its server's name and logo, or where a declared tool comes from. */
function vendorOf(
  version: ToolVersion,
  servers: ReadonlyMap<string, McpServer>,
  words: ToolWords,
): {
  name: string;
  icon: PickerIcon | undefined;
  /** The providing server's name; null for a tool no server provides. */
  server: string | null;
} {
  const server =
    version.serverId === null ? undefined : servers.get(version.serverId);
  if (server !== undefined)
    return {
      name: server.name,
      icon: { name: server.name, url: server.iconUrl },
      server: server.name,
    };
  return { name: words.source(version.source), icon: undefined, server: null };
}

/**
 * One tool as a picker row. `pin` null is the `slug@*` pattern that covers
 * every version; a number is that one version.
 */
function toolOption(
  value: string,
  version: ToolVersion,
  pin: number | null,
  servers: ReadonlyMap<string, McpServer>,
  words: ToolWords,
): PickerOption {
  const vendor = vendorOf(version, servers, words);
  // A source label such as "Custom tool" is not part of a tool's name, so
  // only a server's name is stripped from the title.
  const title = titleOf(version.name, vendor.server);
  const effect = effectOf(version);
  const facts: PickerFact[] = [
    { text: words.effect(effect), tone: EFFECT_TONE[effect] },
    { text: words.risk(version.riskGrade), tone: RISK_TONE[version.riskGrade] },
  ];
  return {
    value,
    label: pin === null ? title : words.pinned(title, pin),
    context: words.context(vendor.name, pin),
    ...(version.description === null || version.description.trim() === ""
      ? {}
      : { description: version.description }),
    ...(vendor.icon === undefined ? {} : { icon: vendor.icon }),
    facts,
  };
}

/**
 * The `mcp.<server uuid>.` prefix each server's tools share, so a pattern a
 * person typed under it is drawn with the server's logo and name. The prefix
 * is read off a slug the server's tools carry; it is matched, never drawn.
 */
function serverNamespaces(
  versions: readonly ToolVersion[],
  servers: ReadonlyMap<string, McpServer>,
): PickerNamespace[] {
  const found = new Map<string, PickerNamespace>();
  for (const version of versions) {
    if (version.serverId === null) continue;
    const server = servers.get(version.serverId);
    const prefix = /^mcp\.[^.]+\./.exec(version.slug)?.[0];
    if (server === undefined || prefix === undefined || found.has(prefix))
      continue;
    found.set(prefix, {
      prefix,
      label: server.name,
      icon: { name: server.name, url: server.iconUrl },
    });
  }
  return [...found.values()];
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
  const [list, servers, words] = await Promise.all([
    walk(PAGE_BOUND, (cursor) =>
      dataSource().tools.versions(ctx, { category: null, cursor }),
    ),
    serversById(ctx),
    toolWords(),
  ]);
  if (!list.ok) return readToActionResult<OptionPage>(list.read);
  const every = new Map<string, PickerOption>();
  const each: PickerOption[] = [];
  for (const version of list.items) {
    const pattern = `${version.slug}@*`;
    if (!every.has(pattern))
      every.set(pattern, toolOption(pattern, version, null, servers, words));
    const exact = `${version.slug}@${String(version.version)}`;
    each.push(toolOption(exact, version, version.version, servers, words));
  }
  return loaded(
    [...every.values(), ...each],
    list.partial,
    serverNamespaces(list.items, servers),
  );
}

/**
 * The tool names one provider has had imported, for picking which of its pins
 * to import again. A version keeps its pin's name, so these are names
 * `import_tools` accepts. A pin never imported is absent, so the picker takes
 * typed names too.
 */
export async function chooseServerTools(
  org: string,
  ws: string,
  serverId: string,
): Promise<ActionResult<OptionPage>> {
  const ctx = await requireViewer(org, ws);
  const [list, servers] = await Promise.all([
    walk(PAGE_BOUND, (cursor) =>
      dataSource().tools.versions(ctx, { category: null, cursor }),
    ),
    serversById(ctx),
  ]);
  if (!list.ok) return readToActionResult<OptionPage>(list.read);
  const server = servers.get(serverId);
  const names = new Map<string, PickerOption>();
  for (const version of list.items) {
    if (version.serverId !== serverId || names.has(version.name)) continue;
    // The API name is what `import_tools` takes, so it stays as the detail.
    names.set(version.name, {
      value: version.name,
      label: titleOf(version.name, server?.name ?? null),
      detail: version.name,
      ...(server === undefined
        ? {}
        : { icon: { name: server.name, url: server.iconUrl } }),
    });
  }
  return loaded([...names.values()], list.partial);
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
      icon: { name: server.name, url: server.iconUrl },
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
  const [list, servers, words] = await Promise.all([
    walk(PAGE_BOUND, (cursor) =>
      dataSource().tools.versions(ctx, { category: null, cursor }),
    ),
    serversById(ctx),
    toolWords(),
  ]);
  if (!list.ok) return readToActionResult<OptionPage>(list.read);
  return loaded(
    list.items.map((version) =>
      toolOption(version.id, version, version.version, servers, words),
    ),
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
