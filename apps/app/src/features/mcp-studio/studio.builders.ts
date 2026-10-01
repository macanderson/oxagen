// Fixtures, typed seam fakes and a DataSource for the MCP Studio tests
// (#4678). The registry values go through the contract's output schema and
// the live port's mapper, as the Tools fixtures do, so a fixture cannot drift
// from the contract. The Studio record has no contract in the app yet (lane
// M10 writes it), so its fixtures are typed by model.ts.
//
// Four servers carry the lane's cases:
//
//   - Stripe (`mcs_01k5s1`): a remote server with 23 tools, two imported, and
//     suggestions nobody has confirmed. `create_payment` joins the registry's
//     `tlv_01k5a1`.
//   - Billing (`mcs_01k5s3`): an OpenAPI source on a private network, two
//     environments, operator OAuth, and a tool with hidden and fixed inputs.
//   - Scratch (`mcs_01k5s4`): a server with no tools.
//   - Warehouse (`mcs_01k5s5`): 600 tools, 200 imported, over its budget, and
//     a registry that pages its 200 versions over two cursor pages.
//
// Every credential is a vault reference. None of these values is a secret.
import type { MemberList } from "@/data/contracts/org";
import {
  KILL_SWITCH_BOARD_LIMIT,
  type KillSwitchBoard,
  KillSwitchBoard as KillSwitchBoardShape,
  type McpServer,
  type McpServerList,
  McpServerList as McpServerListShape,
  type ToolVersionPage,
  ToolVersionPage as ToolVersionPageShape,
} from "@/data/contracts/tools";
import {
  toKillSwitchBoard,
  toMcpServerList,
  toToolVersionPage,
} from "@/data/live/mappers/tools";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";
import {
  killSwitchListOutput,
  mcpServerListOutput,
  toolVersionListOutput,
} from "@/test/tools-outputs";
import type { StoredDraft } from "./draft";
import {
  buildStudioView,
  type StudioClassification,
  type StudioRecord,
  type StudioServerView,
  type StudioTool,
} from "./model";
import type { StudioAt } from "./route";
import type {
  GetStudioDraft,
  OpenStudioReview,
  SaveStudioDraft,
  StudioFinding,
  StudioReview,
} from "./seams";
import type {
  DraftStudioDescription,
  ListStudioFindings,
  TryResult,
  TryStudioTool,
} from "./studio-calls";

export const STRIPE = "mcs_01k5s1";
export const GITHUB = "mcs_01k5s2";
export const BILLING = "mcs_01k5s3";
export const SCRATCH = "mcs_01k5s4";
export const WAREHOUSE = "mcs_01k5s5";

/** The user who flipped every switch in the fixtures (`killSwitchListOutput`). */
export const FLIPPER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// ---- Registry -------------------------------------------------------------

type ServerRow = NonNullable<
  NonNullable<Parameters<typeof mcpServerListOutput>[0]>["servers"]
>[number];

function serverRow(
  publicId: string,
  name: string,
  endpointUrl: string,
  toolCount: number,
): ServerRow {
  const [template] = mcpServerListOutput().servers;
  if (template === undefined) throw new Error("the server fixture has no row");
  return { ...template, publicId, name, endpointUrl, toolCount };
}

/** The workspace's servers: Stripe and GitHub from the Tools fixture, and three more. */
export function studioServers(): McpServerList {
  const base = mcpServerListOutput();
  return McpServerListShape.parse(
    toMcpServerList(
      mcpServerListOutput({
        servers: [
          ...base.servers,
          serverRow(BILLING, "Billing", "https://billing.internal.example/v2", 3),
          serverRow(SCRATCH, "Scratch", "https://scratch.example/mcp", 0),
          serverRow(WAREHOUSE, "Warehouse", "https://warehouse.example/mcp", 600),
        ],
      }),
    ),
  );
}

/** One server of `studioServers`, by its `mcs_…` id. */
export function studioServer(id: string): McpServer {
  const server = studioServers().servers.find((row) => row.id === id);
  if (server === undefined) throw new Error(`no fixture server ${id}`);
  return server;
}

type VersionRow = NonNullable<
  NonNullable<Parameters<typeof toolVersionListOutput>[0]>["items"]
>[number];

function versionRow(
  id: string,
  serverId: string,
  server: string,
  tool: string,
  over: Partial<VersionRow> = {},
): VersionRow {
  const [template] = toolVersionListOutput().items;
  if (template === undefined) throw new Error("the version fixture has no row");
  return {
    ...template,
    id: `tlv_${id}`,
    toolId: `tol_${id}`,
    slug: `${server}__${tool}`,
    name: tool,
    description: null,
    version: 1,
    serverId,
    capabilityId: `mcp.${server}.${tool}`,
    readOnly: false,
    riskGrade: "medium",
    classification: null,
    classifiedAt: null,
    gate: { kind: "open", switchId: null },
    calls30d: 0,
    ...over,
  };
}

const BILLING_VERSIONS: readonly VersionRow[] = [
  versionRow("01k5b1", BILLING, "billing", "list_invoices", {
    description: "Lists invoices for one tenant.",
    readOnly: true,
    riskGrade: "low",
    classification: {
      sideEffect: "read",
      egress: "org_tenant",
      impacts: [],
      measures: {},
      dataClasses: ["invoice"],
    },
    classifiedAt: "2026-09-15T09:00:00.000Z",
    calls30d: 88,
  }),
  versionRow("01k5b2", BILLING, "billing", "create_refund", {
    description: "Refunds an invoice.",
    riskGrade: "medium",
  }),
];

/**
 * The registry page every Studio page reads: the Tools fixture's Stripe and
 * GitHub versions and Billing's two.
 */
export function studioVersions(): ToolVersionPage {
  return ToolVersionPageShape.parse(
    toToolVersionPage(
      toolVersionListOutput({
        items: [...toolVersionListOutput().items, ...BILLING_VERSIONS],
      }),
    ),
  );
}

/** Warehouse's tool names: `tool_000` to `tool_599`. */
export function warehouseTool(index: number): string {
  return `tool_${String(index).padStart(3, "0")}`;
}

/** How many tools Warehouse offers, and how many of them are imported. */
export const WAREHOUSE_TOOLS = 600;
export const WAREHOUSE_IMPORTED = 200;

/** The cursor Warehouse's first registry page hands to its second. */
export const WAREHOUSE_PAGE_2 = "page-2";

/**
 * One of Warehouse's two registry pages, 100 of its 200 imported tools each
 * (every third tool). The first, at no cursor, carries a cursor to the
 * second; the second is the last. list_tool_versions pages at 100 at most.
 */
export function warehouseVersions(
  cursor: string | null = null,
): ToolVersionPage {
  const second = cursor === WAREHOUSE_PAGE_2;
  const items: VersionRow[] = [];
  for (let row = second ? 100 : 0; row < (second ? 200 : 100); row += 1) {
    const index = row * 3;
    items.push(
      versionRow(`wh${String(index)}`, WAREHOUSE, "warehouse", warehouseTool(index)),
    );
  }
  return ToolVersionPageShape.parse(
    toToolVersionPage(
      toolVersionListOutput({
        items,
        nextCursor: second ? null : WAREHOUSE_PAGE_2,
      }),
    ),
  );
}

type SwitchRow = NonNullable<
  NonNullable<Parameters<typeof killSwitchListOutput>[0]>["switches"]
>[number];

/** A switch that is on: a person turned the target off and nobody cleared it. */
export function offSwitch(
  id: string,
  kind: "tool_server" | "tool_version",
  target: string,
): SwitchRow {
  return {
    id,
    target:
      kind === "tool_server"
        ? { kind: "tool_server", id: target }
        : { kind: "tool_version", id: target },
    scope: "workspace",
    on: true,
    reason: "Refunds ran twice in the sandbox.",
    flippedBy: FLIPPER,
    flippedAt: "2026-09-26T10:00:00.000Z",
    clearedAt: null,
    clearedBy: null,
  };
}

/**
 * The switch board: the Tools fixture's three switches, one of them Stripe's
 * server switch turned back on, and any `extra`. Pass `limit` equal to the
 * switch count for a board read at its ceiling.
 */
export function studioBoard(
  extra: readonly SwitchRow[] = [],
  limit: number = KILL_SWITCH_BOARD_LIMIT,
): KillSwitchBoard {
  const base = killSwitchListOutput();
  return KillSwitchBoardShape.parse(
    toKillSwitchBoard(
      killSwitchListOutput({ switches: [...base.switches, ...extra] }),
      limit,
    ),
  );
}

/** The org roster: one admin, whose public id no switch fixture names. */
export function studioMembers(): MemberList {
  return {
    members: [
      {
        id: "usr_01k5m1",
        name: "Dana Reyes",
        email: "dana@acme.example",
        avatarUrl: null,
        role: "admin",
        joinedAt: "2026-01-05T09:00:00.000Z",
      },
    ],
    invitations: [],
  };
}

// ---- Studio records -------------------------------------------------------

type RecordTool = StudioRecord["tools"][number];

function recordTool(name: string, over: Partial<RecordTool> = {}): RecordTool {
  return {
    name,
    imported: false,
    tokens: null,
    serverDescription: null,
    annotations: [],
    classification: null,
    description: null,
    shaping: null,
    feedback: null,
    ...over,
  };
}

/** A classification Studio suggested and nobody confirmed. */
function suggestion(
  risk: StudioClassification["risk"],
  sideEffect: StudioClassification["sideEffect"],
  basis: NonNullable<StudioClassification["basis"]>,
  impacts: readonly string[] = [],
): StudioClassification {
  return {
    risk,
    sideEffect,
    egress: "third_party",
    impacts,
    confirmed: false,
    basis,
  };
}

/** Stripe's tools that are offered and not imported. */
const STRIPE_AVAILABLE: readonly RecordTool[] = [
  recordTool("cancel_subscription", {
    tokens: 301,
    annotations: ["destructiveHint"],
    classification: suggestion("high", "write", "annotations", [
      "changes_entitlement",
    ]),
  }),
  recordTool("create_coupon", {
    tokens: 220,
    classification: suggestion("medium", "write", "fail_safe"),
  }),
  recordTool("create_customer", {
    tokens: 244,
    classification: suggestion("medium", "write", "source_hint"),
  }),
  recordTool("create_invoice", {
    tokens: 296,
    classification: suggestion("medium", "write", "source_hint"),
  }),
  recordTool("create_invoice_item", {
    tokens: 233,
    classification: suggestion("medium", "write", "source_hint"),
  }),
  recordTool("create_payment_link", {
    tokens: 262,
    classification: suggestion("high", "write", "source_hint", [
      "moves_money",
    ]),
  }),
  recordTool("create_price", {
    tokens: 218,
    classification: suggestion("medium", "write", "source_hint"),
  }),
  recordTool("create_product", {
    tokens: 205,
    classification: suggestion("medium", "write", "source_hint"),
  }),
  recordTool("create_refund", {
    tokens: 318,
    serverDescription: "Refunds a charge, in whole or in part.",
    annotations: ["destructiveHint"],
    classification: suggestion("critical", "irreversible", "annotations", [
      "moves_money",
    ]),
  }),
  recordTool("finalize_invoice", {
    tokens: 190,
    classification: suggestion("high", "write", "fail_safe"),
  }),
  recordTool("list_coupons", {
    tokens: 150,
    annotations: ["readOnlyHint"],
    classification: suggestion("low", "read", "annotations"),
  }),
  recordTool("list_disputes", {
    tokens: 162,
    annotations: ["readOnlyHint"],
    classification: suggestion("low", "read", "annotations"),
  }),
  recordTool("list_invoices", {
    tokens: 171,
    annotations: ["readOnlyHint"],
    classification: suggestion("low", "read", "annotations"),
  }),
  recordTool("list_payment_intents", {
    tokens: 188,
    annotations: ["readOnlyHint"],
    classification: suggestion("low", "read", "annotations"),
  }),
  recordTool("list_prices", {
    tokens: 149,
    annotations: ["readOnlyHint"],
    classification: suggestion("low", "read", "annotations"),
  }),
  recordTool("list_products", {
    tokens: 152,
    annotations: ["readOnlyHint"],
    classification: suggestion("low", "read", "annotations"),
  }),
  recordTool("list_subscriptions", {
    tokens: 176,
    annotations: ["readOnlyHint"],
    classification: suggestion("low", "read", "annotations"),
  }),
  recordTool("retrieve_balance", {
    tokens: 120,
    annotations: ["readOnlyHint"],
    classification: suggestion("low", "read", "annotations"),
  }),
  // Unmeasured and unclassified: importing it leaves the total unknown.
  recordTool("search_documentation", {
    serverDescription: "Searches the Stripe documentation.",
  }),
  recordTool("update_dispute", {
    tokens: 240,
    classification: suggestion("high", "write", "fail_safe"),
  }),
  recordTool("update_subscription", {
    tokens: 280,
    classification: suggestion("high", "write", "fail_safe", [
      "changes_entitlement",
    ]),
  }),
];

/** Stripe's definition budget and the tokens its two imported tools add. */
export const STRIPE_BUDGET = 8000;
export const STRIPE_IMPORTED_TOKENS = 412 + 268;

/**
 * Stripe's record: a remote server offering 23 tools. Two are imported.
 * `create_payment` joins the registry's `tlv_01k5a1` and takes its
 * classification from it; `list_customers` has no version yet. The other 21
 * carry suggestions nobody confirmed, except `search_documentation`, which
 * has none and no token count.
 */
export function stripeRecord(): StudioRecord {
  return {
    folder: "tools/servers/stripe",
    source: {
      type: "remote",
      url: "https://mcp.stripe.example/v1",
      transport: "http",
      network: "cloud",
    },
    auth: {
      mode: "service",
      scheme: "bearer",
      credential: "oxagen:credential/stripe-restricted",
    },
    environments: [],
    exposure: { mode: "direct", definitionBudget: STRIPE_BUDGET },
    sync: { schedule: "on-change", lastAt: "2026-09-27T08:00:00.000Z" },
    tools: [
      recordTool("create_payment", {
        imported: true,
        tokens: 412,
        serverDescription: "Creates a PaymentIntent and confirms it.",
        annotations: ["destructiveHint"],
        shaping: {
          hide: ["idempotency_key"],
          fixed: [{ name: "currency", value: "usd" }],
          select: ["$.id", "$.status"],
          selection: null,
        },
        feedback: {
          counts: { calls: 1204, schemaRejections: 3, errorResults: 12, retries: 5 },
          notes: ["The amount is in cents; two runs sent dollars."],
        },
      }),
      recordTool("list_customers", {
        imported: true,
        tokens: 268,
        serverDescription: "Lists customers, newest first.",
        annotations: ["readOnlyHint"],
        classification: {
          risk: "low",
          sideEffect: "read",
          egress: "third_party",
          impacts: [],
          confirmed: true,
          basis: null,
        },
        description: "Lists Stripe customers by email.",
      }),
      ...STRIPE_AVAILABLE,
    ],
  };
}

/**
 * Billing's record: an OpenAPI definition in a repository, reached through a
 * relay, with a sandbox and a production environment. `list_invoices` hides
 * `tenant_id` and fixes `X-Request-Source`; `create_refund` is imported
 * unclassified; `void_invoice` is offered with a suggestion.
 */
export function billingRecord(): StudioRecord {
  return {
    folder: "tools/servers/billing",
    source: {
      type: "openapi",
      from: "repository",
      repo: "github.com/acme/billing-api",
      path: "openapi/billing.yaml",
      ref: "main",
      url: null,
      network: "relay:a-intel-east",
    },
    auth: {
      mode: "operator-oauth",
      scheme: "oauth2",
      credential: "oxagen:credential/billing-oauth",
    },
    environments: [
      {
        name: "sandbox",
        sandbox: true,
        url: "https://billing-sandbox.internal.example/v2",
        network: "relay:a-intel-east",
        credential: "oxagen:credential/billing-sandbox",
      },
      {
        name: "production",
        sandbox: false,
        url: "https://billing.internal.example/v2",
        network: "relay:a-intel-east",
        credential: "oxagen:credential/billing-production",
      },
    ],
    exposure: { mode: "direct", definitionBudget: 8000 },
    sync: { schedule: "daily", lastAt: "2026-09-27T06:00:00.000Z" },
    tools: [
      recordTool("list_invoices", {
        imported: true,
        tokens: 380,
        serverDescription: "GET /invoices",
        shaping: {
          hide: ["tenant_id"],
          fixed: [{ name: "X-Request-Source", value: "oxagen" }],
          select: ["$.data[*].id", "$.data[*].total"],
          selection: null,
        },
        feedback: {
          counts: { calls: 88, schemaRejections: 0, errorResults: 2, retries: 1 },
          notes: [],
        },
      }),
      recordTool("create_refund", {
        imported: true,
        tokens: 420,
        serverDescription: "POST /invoices/{id}/refunds",
      }),
      recordTool("void_invoice", {
        tokens: 350,
        serverDescription: "POST /invoices/{id}/void",
        classification: {
          risk: "critical",
          sideEffect: "irreversible",
          egress: "org_tenant",
          impacts: ["moves_money"],
          confirmed: false,
          basis: "http_method",
        },
      }),
    ],
  };
}

/** Scratch's record: a remote server that offers no tools. */
export function scratchRecord(): StudioRecord {
  return {
    folder: "tools/servers/scratch",
    source: {
      type: "remote",
      url: "https://scratch.example/mcp",
      transport: "http",
      network: null,
    },
    auth: { mode: "none", scheme: null, credential: null },
    environments: [],
    exposure: { mode: "direct", definitionBudget: 8000 },
    sync: { schedule: "manual", lastAt: null },
    tools: [],
  };
}

const WAREHOUSE_RISKS = ["low", "medium", "high", "critical"] as const;
const WAREHOUSE_EFFECTS = ["read", "write", "irreversible"] as const;

/**
 * Warehouse's record: 600 tools of 50 tokens each. Every third is imported,
 * so 200 add 10,000 tokens against a budget of 8,000.
 */
export function warehouseRecord(): StudioRecord {
  const tools: RecordTool[] = [];
  for (let index = 0; index < WAREHOUSE_TOOLS; index += 1) {
    const risk = WAREHOUSE_RISKS[index % WAREHOUSE_RISKS.length] ?? "low";
    const sideEffect =
      WAREHOUSE_EFFECTS[index % WAREHOUSE_EFFECTS.length] ?? "read";
    tools.push(
      recordTool(warehouseTool(index), {
        imported: index % 3 === 0,
        tokens: 50,
        classification: {
          risk,
          sideEffect,
          egress: "org_tenant",
          impacts: [],
          confirmed: index % 3 === 0,
          basis: index % 3 === 0 ? null : "fail_safe",
        },
      }),
    );
  }
  return {
    folder: "tools/servers/warehouse",
    source: {
      type: "graphql",
      from: "introspection",
      repo: null,
      path: null,
      ref: null,
      url: "https://warehouse.example/graphql",
      network: "cloud",
    },
    auth: {
      mode: "service",
      scheme: "header",
      credential: "oxagen:credential/warehouse-key",
    },
    environments: [],
    exposure: { mode: "search", definitionBudget: 8000 },
    sync: { schedule: "on-change", lastAt: "2026-09-27T07:30:00.000Z" },
    tools,
  };
}

/**
 * A registry package the local gateway runs on two machine groups, passing
 * `GITHUB_TOKEN` through by name.
 */
export function packageRecord(): StudioRecord {
  return {
    folder: "tools/servers/github",
    source: {
      type: "registry",
      registry: "https://registry.modelcontextprotocol.io",
      server: "io.github.github/github-mcp-server",
      version: "0.9.0",
      network: null,
      machines: ["build-agents", "laptops"],
      registryType: "npm",
      env: ["GITHUB_TOKEN"],
    },
    auth: {
      mode: "service",
      scheme: "bearer",
      credential: "oxagen:credential/github-bot",
    },
    environments: [],
    exposure: { mode: "direct", definitionBudget: 8000 },
    sync: { schedule: "on-change", lastAt: null },
    tools: [],
  };
}

/** A local command the local gateway starts on one machine group. */
export function localRecord(): StudioRecord {
  return {
    folder: "tools/servers/files",
    source: {
      type: "local",
      command: "npx",
      args: ["-y", "@acme/files-mcp"],
      env: ["FILES_ROOT"],
      machines: ["build-agents"],
    },
    auth: { mode: "none", scheme: null, credential: null },
    environments: [],
    exposure: { mode: "direct", definitionBudget: 8000 },
    sync: { schedule: "manual", lastAt: null },
    tools: [],
  };
}

/**
 * One server's page as buildStudioView joins it. The record defaults to the
 * server's own fixture, and null draws the page before discovery wrote one.
 */
export function studioView(
  serverId: string,
  record: StudioRecord | null = recordOf(serverId),
  board: KillSwitchBoard | null = studioBoard(),
): StudioServerView {
  return buildStudioView({
    server: studioServer(serverId),
    versions: versionsOf(serverId).items,
    board,
    record,
  });
}

/** Each server's own record fixture; null for GitHub, which has none. */
export function recordOf(serverId: string): StudioRecord | null {
  switch (serverId) {
    case STRIPE:
      return stripeRecord();
    case BILLING:
      return billingRecord();
    case SCRATCH:
      return scratchRecord();
    case WAREHOUSE:
      return warehouseRecord();
    default:
      return null;
  }
}

/** The registry page a server's Studio page reads at a cursor. */
export function versionsOf(
  serverId: string | null,
  cursor: string | null = null,
): ToolVersionPage {
  return serverId === WAREHOUSE ? warehouseVersions(cursor) : studioVersions();
}

/** One tool, joined, for a test of the tool panel alone. */
export function studioTool(
  name: string,
  over: Partial<StudioTool> = {},
): StudioTool {
  return {
    name,
    imported: true,
    versionId: null,
    version: null,
    tokens: null,
    classification: null,
    description: null,
    serverDescription: null,
    annotations: [],
    shaping: null,
    feedback: null,
    killSwitch: null,
    ...over,
  };
}

/** A GraphQL operation with a selection set, for the tool panel. */
export function graphqlTool(): StudioTool {
  return studioTool("orders", {
    tokens: 210,
    serverDescription: "query orders(first: Int, after: String)",
    shaping: {
      hide: [],
      fixed: [],
      select: [],
      selection: "{ edges { node { id total status } } }",
    },
  });
}

// ---- Drafts ---------------------------------------------------------------

/** The workspace every Studio test renders in: the viewer's org and workspace. */
export const STUDIO_AT: StudioAt = { org: "acme", ws: "core-platform" };

/** The sessionStorage key of a draft keyed by the server's folder name. */
export function draftKey(serverName: string, at: StudioAt = STUDIO_AT): string {
  return `oxagen.mcp-studio.draft.${at.org}/${at.ws}.server.${serverName}`;
}

/** The sessionStorage key of a draft for a server whose record names no folder. */
export function idDraftKey(serverId: string, at: StudioAt = STUDIO_AT): string {
  return `oxagen.mcp-studio.draft.${at.org}/${at.ws}.id.${serverId}`;
}

/** Store a draft where the page reads it, before the page renders. */
export function seedDraft(key: string, draft: StoredDraft): void {
  window.sessionStorage.setItem(key, JSON.stringify(draft));
}

// ---- Seam answers ---------------------------------------------------------

type SaveAnswer = Awaited<ReturnType<SaveStudioDraft>>;
type GetAnswer = Awaited<ReturnType<GetStudioDraft>>;
type OpenAnswer = Awaited<ReturnType<OpenStudioReview>>;
type DraftAnswer = Awaited<ReturnType<DraftStudioDescription["call"]>>;
type FindingsAnswer = Awaited<ReturnType<ListStudioFindings["call"]>>;
type SavedDraft = Extract<SaveAnswer, { ok: true }>["draft"];

/** A draft as M11 stores it, after one save by default. */
export function savedDraft(over: Partial<SavedDraft> = {}): SavedDraft {
  return {
    server: "billing",
    serverId: BILLING,
    ops: [],
    serverToml: null,
    source: null,
    revision: 1,
    pr: null,
    updatedAt: "2026-09-28T09:00:00.000Z",
    ...over,
  };
}

/** Findings from each level, as lint (lane M5) words them. */
export function studioFindings(): StudioFinding[] {
  return [
    {
      rule: "missing_classification",
      level: "error",
      tool: "create_refund",
      field: null,
      message: "create_refund is imported with no classification.",
      fix: "Classify create_refund.",
    },
    {
      rule: "enum_without_description",
      level: "warning",
      tool: "list_invoices",
      field: "inputSchema.properties.status.enum",
      message: "status has an enum with no description.",
      fix: "Describe each status value.",
    },
    {
      rule: "near_budget",
      level: "info",
      tool: null,
      field: null,
      message: "The imported tools use 10% of the definition budget.",
      fix: "No change is needed.",
    },
  ];
}

/** What one Review opened. */
export function studioReview(over: Partial<StudioReview> = {}): StudioReview {
  return {
    number: 4721,
    url: "https://github.com/acme/steering/pull/4721",
    branch: "studio/billing",
    headSha: "0f3c2a1b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a",
    imported: ["void_invoice"],
    removed: [],
    reclassified: [
      {
        tool: "create_refund",
        before: {
          risk: "medium",
          sideEffect: "write",
          egress: "org_tenant",
          impacts: [],
        },
        after: {
          risk: "critical",
          sideEffect: "irreversible",
          egress: "org_tenant",
          impacts: ["moves_money"],
        },
      },
    ],
    tokens: { definitions: 1150, budget: 8000 },
    findings: [],
    ...over,
  };
}

/**
 * A Test tab result whose request and raw response carry credential headers,
 * so the page's save has something to strip.
 */
export function tryWithCredentials(): TryResult {
  return {
    ok: true,
    request: JSON.stringify({
      method: "GET",
      url: "https://billing-sandbox.internal.example/v2/invoices",
      headers: {
        accept: "application/json",
        Authorization: "Bearer test-token",
        "X-Request-Source": "oxagen",
      },
      body: null,
    }),
    raw: JSON.stringify({
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=test-session",
      },
      body: { data: [{ id: "in_1", total: 1200, tenant_id: "ten_1" }] },
    }),
    shaped: JSON.stringify({ data: [{ id: "in_1", total: 1200 }] }),
  };
}

/** A Test tab result with no credential header anywhere. */
export function tryClean(): TryResult {
  return {
    ok: true,
    request: JSON.stringify({
      method: "GET",
      url: "https://billing-sandbox.internal.example/v2/invoices",
      headers: { accept: "application/json" },
      body: null,
    }),
    raw: JSON.stringify({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { data: [] },
    }),
    shaped: JSON.stringify({ data: [] }),
  };
}

/**
 * A seam that gives its answers in turn, repeating the last, and records
 * each input it was called with.
 */
function answering<I, O>(
  answers: readonly O[],
): { fn: (input: I) => Promise<O>; calls: I[] } {
  const calls: I[] = [];
  return {
    calls,
    fn: (input) => {
      calls.push(input);
      const answer = answers[Math.min(calls.length, answers.length) - 1];
      return answer === undefined
        ? Promise.reject(new Error("the fake seam has no answer"))
        : Promise.resolve(answer);
    },
  };
}

export function fakeSave(...answers: SaveAnswer[]) {
  const { fn, calls } = answering<Parameters<SaveStudioDraft>[0], SaveAnswer>(
    answers,
  );
  const save: SaveStudioDraft = fn;
  return { save, calls };
}

export function fakeGet(...answers: GetAnswer[]) {
  const { fn, calls } = answering<Parameters<GetStudioDraft>[0], GetAnswer>(
    answers,
  );
  const get: GetStudioDraft = fn;
  return { get, calls };
}

export function fakeOpen(...answers: OpenAnswer[]) {
  const { fn, calls } = answering<Parameters<OpenStudioReview>[0], OpenAnswer>(
    answers,
  );
  const open: OpenStudioReview = fn;
  return { open, calls };
}

/**
 * try_studio_tool giving its answers in turn. `calls` keeps each input, and
 * `workspaces` the workspace each call named.
 */
export function fakeTry(...answers: TryResult[]) {
  const { fn, calls } = answering<
    Parameters<TryStudioTool["call"]>[1],
    TryResult
  >(answers);
  const workspaces: StudioAt[] = [];
  const call: TryStudioTool = {
    name: "try_studio_tool",
    call: (at, input) => {
      workspaces.push(at);
      return fn(input);
    },
  };
  return { call, calls, workspaces };
}

/** draft_studio_description giving its answers in turn. */
export function fakeDraft(...answers: DraftAnswer[]) {
  const { fn, calls } = answering<
    Parameters<DraftStudioDescription["call"]>[1],
    DraftAnswer
  >(answers);
  const workspaces: StudioAt[] = [];
  const draft: DraftStudioDescription = {
    name: "draft_studio_description",
    call: (at, input) => {
      workspaces.push(at);
      return fn(input);
    },
  };
  return { draft, calls, workspaces };
}

/** list_studio_findings' answer for one folder: the draft's findings. */
export function findingsAnswer(
  findings: StudioFinding[] = studioFindings(),
  server = "stripe",
): FindingsAnswer {
  return {
    ok: true,
    server,
    basis: "draft",
    revision: 1,
    tokens: { definitions: 1150, budget: 8000 },
    findings,
  };
}

// ---- DataSource -----------------------------------------------------------

type VersionsQuery = {
  category: string | null;
  cursor: string | null;
  serverId: string | null;
};

type StudioReads = {
  mcpServers?: Read<McpServerList>;
  /** A function answers per query; the default answers each server's page. */
  versions?: Read<ToolVersionPage> | ((q: VersionsQuery) => Read<ToolVersionPage>);
  killSwitches?: Read<KillSwitchBoard>;
  members?: Read<MemberList>;
};

/**
 * A DataSource answering the four reads a Studio page makes, each defaulting
 * to its fixture; `calls` records each read's arguments. Every other read
 * refuses, so a page that reaches for one fails its test.
 */
export function studioSource(reads: StudioReads = {}) {
  const calls: Record<keyof StudioReads, unknown[][]> = {
    mcpServers: [],
    versions: [],
    killSwitches: [],
    members: [],
  };
  const refuse = () => Promise.reject(new Error("not a Studio read"));
  const answer =
    <T>(read: Read<T>, name: keyof StudioReads) =>
    (...args: unknown[]): Promise<Read<T>> => {
      calls[name].push(args);
      return Promise.resolve(read);
    };
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse, named: refuse },
    conversations: { latest: refuse, list: refuse, byId: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: {
      context: refuse,
      preferences: refuse,
      counts: refuse,
      notifications: refuse,
      assistantEngine: refuse,
    },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      retention: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    runs: {
      list: refuse,
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      turns: refuse,
      transcript: refuse,
      chain: refuse,
      commands: refuse,
      outputs: refuse,
      work: refuse,
      issues: refuse,
      context: refuse,
      findings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
    interjections: { open: refuse, forRun: refuse },
    agents: {
      list: refuse,
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
      priceBook: refuse,
      operatorRanking: refuse,
      unpricedModels: refuse,
      unproductive: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      // Answered below the object literal, once `source` exists to reassign.
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      dataPlane: refuse,
      slackConnection: refuse,
      workspaceFacts: refuse,
      sso: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      layout: refuse,
      hub: refuse,
      deliveries: refuse,
      memories: refuse,
      tree: refuse,
    },
    steeringRepo: { get: refuse },
    tools: {
      versions: (ctx, q) => {
        calls.versions.push([ctx, q]);
        const read =
          reads.versions ??
          ((query: VersionsQuery) =>
            readOk(versionsOf(query.serverId, query.cursor)));
        return Promise.resolve(typeof read === "function" ? read(q) : read);
      },
      grants: refuse,
      killSwitches: answer(
        reads.killSwitches ?? readOk(studioBoard()),
        "killSwitches",
      ),
      approvalRules: refuse,
      connections: refuse,
      mcpServers: answer(
        reads.mcpServers ?? readOk(studioServers()),
        "mcpServers",
      ),
      toolbelts: refuse,
      toolbelt: refuse,
    },
    mandates: { list: refuse, get: refuse },
  };
  source.org.members = answer(
    reads.members ?? readOk({ members: [], invitations: [] }),
    "members",
  );
  return { source, calls };
}
