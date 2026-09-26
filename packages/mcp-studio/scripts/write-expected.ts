// write-expected.ts: writes the stripe and billing fixtures' lock files and
// the expected files the lanes build against.
//
//   tsx packages/mcp-studio/scripts/write-expected.ts
//
// It writes, under packages/mcp-studio/fixtures:
//
// - servers/<name>/tools.lock.json: what lock() (M4) must write for the
//   folder, byte for byte, with no previous lock.
// - expected/<name>/upstream.json: every UpstreamTool the source offers. For
//   billing it is what importOpenApi (M1) must return for openapi.yaml. For
//   stripe it is tools/list through upstreamFromMcpTool.
// - expected/<name>/manifest.json: what toManifestServer (M4) must return.
// - expected/tool-manifest.json: both servers, as publish writes them.
//
// The compile below covers only the tools.toml keys these two folders use.
// It stops on any other key, so a fixture change cannot quietly outrun it.
// The real compile is lane M4's.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toolName } from "@oxagen/oxagen/steering-repo/names";
import { DEFAULT_SERVER_DEFINITION_BUDGET } from "@oxagen/oxagen/steering-repo/tokens";
import { effectiveAnnotations } from "../src/contract/classification";
import { definitionHash, definitionTokens, documentHash, upstreamHash } from "../src/contract/hashes";
import { formatJson } from "../src/contract/json";
import {
  mcpToolsLockSchema,
  type DefinitionLockSource,
  type McpLockSource,
  type McpToolsLock,
} from "../src/contract/lock";
import {
  manifestServerSchema,
  toolManifestSchema,
  type EffectiveDefinition,
  type ManifestEnvironment,
  type ManifestServer,
  type ManifestTool,
} from "../src/contract/manifest";
import { mcpToolsListResultSchema } from "../src/contract/mcp-tool";
import { parseServerToml, parseToolsToml, type ReadResult } from "../src/contract/parse";
import { agentEnvironment, isDefinitionSource, type McpServer } from "../src/contract/server";
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_RESULT_BYTES,
  MAX_ITEMS_LIMIT,
  type McpTools,
  type ToolsEntry,
} from "../src/contract/tools";
import { lockedUpstream, upstreamFromMcpTool } from "../src/model/from-mcp";
import { builtinSecurityScheme, type SecurityScheme } from "../src/model/security-scheme";
import { upstreamToolSchema, type UpstreamTool } from "../src/model/upstream-tool";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

function read(path: string): string {
  return readFileSync(`${FIXTURES}${path}`, "utf8");
}

function write(path: string, value: unknown): void {
  writeFileSync(`${FIXTURES}${path}`, formatJson(value));
  console.log(`wrote fixtures/${path}`);
}

function valid<T>(path: string, result: ReadResult<T>): T {
  if (!result.ok) throw new Error(`${path}: ${JSON.stringify(result.issues)}`);
  return result.value;
}

// ── billing: what importOpenApi returns for servers/billing/openapi.yaml ─────

const chargeProperties = {
  id: { type: "string" },
  amount: { type: "integer" },
  currency: { type: "string" },
  status: { type: "string", enum: ["pending", "succeeded", "failed"] },
};
const billingSecurity = [{ oauth: ["billing"] }];

const billingUpstream: UpstreamTool[] = [
  {
    name: "list_charges",
    description: "List a customer's charges.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "The customer whose charges to list." },
        cursor: { type: "string", description: "The next_cursor from the previous page." },
      },
      required: ["customer_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        data: { type: "array", items: { type: "object", properties: chargeProperties } },
        next_cursor: { type: "string" },
      },
    },
    paging: { style: "cursor", input: "cursor", next: "next_cursor", items: "data" },
    request: {
      kind: "http",
      operation: "listCharges",
      method: "GET",
      path: "/customers/{customer_id}/charges",
      parameters: [
        { name: "customer_id", in: "path", property: "customer_id", required: true },
        { name: "cursor", in: "query", property: "cursor", required: false },
      ],
      response: { status: "200", media_type: "application/json" },
      security: billingSecurity,
    },
  },
  {
    name: "get_charge",
    description: "Read one charge.",
    inputSchema: {
      type: "object",
      properties: { charge_id: { type: "string" } },
      required: ["charge_id"],
    },
    outputSchema: { type: "object", properties: chargeProperties },
    suggestion: { risk: "low", side_effect: "read", egress: "org_tenant" },
    request: {
      kind: "http",
      operation: "getCharge",
      method: "GET",
      path: "/charges/{charge_id}",
      parameters: [{ name: "charge_id", in: "path", property: "charge_id", required: true }],
      response: { status: "200", media_type: "application/json" },
      security: billingSecurity,
    },
  },
  {
    name: "create_refund",
    description: "Create a refund for a charge.",
    inputSchema: {
      type: "object",
      properties: {
        "X-Request-Source": { type: "string" },
        charge_id: { type: "string", description: "The charge to refund." },
        amount: { type: "integer", minimum: 1 },
        reason: { type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer"] },
      },
      required: ["charge_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        amount: { type: "integer" },
        status: { type: "string", enum: ["pending", "succeeded", "failed", "canceled"] },
      },
    },
    request: {
      kind: "http",
      operation: "createRefund",
      method: "POST",
      path: "/refunds",
      parameters: [{ name: "X-Request-Source", in: "header", property: "X-Request-Source", required: false }],
      body: {
        in: "spread",
        media_type: "application/json",
        required: true,
        properties: ["charge_id", "amount", "reason"],
      },
      response: { status: "201", media_type: "application/json" },
      security: billingSecurity,
    },
  },
];

const billingSecuritySchemes: Record<string, SecurityScheme> = {
  oauth: {
    type: "oauth2",
    authorization_url: "https://login.a-intel.com/oauth/authorize",
    token_url: "https://login.a-intel.com/oauth/token",
    scopes: ["billing"],
  },
};

// ── The compile these two folders need ───────────────────────────────────────

/** The tools.toml keys this compile applies. Any other key stops the script. */
const HANDLED_KEYS = new Set<keyof ToolsEntry>([
  "risk",
  "side_effect",
  "egress",
  "impacts",
  "measures",
  "data_classes",
  "upstream",
  "operation",
  "description",
  "hide",
  "fixed",
  "select",
  "redact",
  "max_result_bytes",
  "paginate",
  "max_items",
  "idempotency_header",
]);

function findUpstream(key: string, entry: ToolsEntry, upstream: readonly UpstreamTool[]): UpstreamTool {
  const found = upstream.find((tool) =>
    entry.operation === undefined
      ? tool.request.kind === "mcp" && tool.request.tool === (entry.upstream ?? key)
      : tool.request.kind === "http" && tool.request.operation === entry.operation,
  );
  if (found === undefined) throw new Error(`tools.toml ${key}: no upstream tool`);
  return found;
}

/** inputSchema without the hidden and fixed inputs, which the agent never sends. */
function agentInputSchema(
  inputSchema: UpstreamTool["inputSchema"],
  removed: ReadonlySet<string>,
): UpstreamTool["inputSchema"] {
  if (removed.size === 0) return inputSchema;
  const properties = Object.fromEntries(
    Object.entries((inputSchema.properties ?? {}) as Record<string, unknown>).filter(([name]) => !removed.has(name)),
  );
  const required = ((inputSchema.required ?? []) as string[]).filter((name) => !removed.has(name));
  const out: UpstreamTool["inputSchema"] = { ...inputSchema, properties };
  if (required.length > 0) out.required = required;
  else delete out.required;
  return out;
}

interface Compiled {
  key: string;
  upstream: UpstreamTool;
  tool: Omit<ManifestTool, "version" | "upstream_hash">;
}

function compileTool(server: McpServer, tools: McpTools, key: string, entry: ToolsEntry, upstream: readonly UpstreamTool[]): Compiled {
  for (const field of Object.keys(entry)) {
    if (!HANDLED_KEYS.has(field as keyof ToolsEntry)) throw new Error(`tools.toml ${key}: ${field} is not handled here`);
  }
  const source = findUpstream(key, entry, upstream);
  const removed = new Set([...(entry.hide ?? []), ...Object.keys(entry.fixed ?? {})]);
  const definition: EffectiveDefinition = {
    name: toolName(server.name, key),
    inputSchema: agentInputSchema(source.inputSchema, removed),
    annotations: effectiveAnnotations(entry),
  };
  if (source.title !== undefined) definition.title = source.title;
  const description = entry.description ?? source.description;
  if (description !== undefined) definition.description = description;
  if (source.outputSchema !== undefined) definition.outputSchema = source.outputSchema;

  const tool: Omit<ManifestTool, "version" | "upstream_hash"> = {
    name: definition.name,
    definition_hash: definitionHash(definition),
    definition,
    tokens: definitionTokens(definition),
    classification: {
      risk: entry.risk,
      side_effect: entry.side_effect,
      egress: entry.egress,
      impacts: entry.impacts ?? [],
      measures: entry.measures ?? {},
      data_classes: entry.data_classes ?? [],
    },
    shaping: {
      hide: entry.hide ?? [],
      fixed: entry.fixed ?? {},
      defaults: {},
      rename: {},
      select: entry.select ?? [],
      redact: entry.redact ?? [],
      max_result_bytes: entry.max_result_bytes ?? tools.defaults?.max_result_bytes ?? DEFAULT_MAX_RESULT_BYTES,
      deadline_ms: DEFAULT_DEADLINE_MS,
    },
    request: source.request,
  };
  if (entry.paginate !== undefined) {
    tool.shaping.paginate = entry.paginate;
    tool.shaping.max_items = entry.max_items ?? MAX_ITEMS_LIMIT;
  }
  if (entry.idempotency_header !== undefined) tool.shaping.idempotency_header = entry.idempotency_header;
  if (source.paging !== undefined) tool.paging = source.paging;
  if (source.deprecated === true) tool.deprecated = true;
  return { key, upstream: source, tool };
}

function environments(server: McpServer): Record<string, ManifestEnvironment> {
  const source = server.source;
  if (source.type === "local") throw new Error("a local server is not handled here");
  const sourceUrl = "url" in source ? source.url : undefined;
  const sandbox = agentEnvironment(server);
  const table = server.environments ?? { [sandbox]: {} };
  const out: Record<string, ManifestEnvironment> = {};
  for (const [name, env] of Object.entries(table)) {
    const resolved: ManifestEnvironment = {
      sandbox: name === sandbox,
      network: env.network ?? source.network ?? "cloud",
    };
    const url = env.url ?? sourceUrl;
    if (url !== undefined) resolved.url = url;
    const credential = env.credential ?? server.auth?.credential;
    if (credential !== undefined) resolved.credential = credential;
    out[name] = resolved;
  }
  return out;
}

function auth(server: McpServer, pinned: McpLockSource | DefinitionLockSource): ManifestServer["auth"] {
  const declared = server.auth;
  if (declared === undefined || declared.mode === "none" || declared.scheme === undefined) return null;
  let apply: SecurityScheme | undefined;
  if (isDefinitionSource(server.source)) {
    apply = "security_schemes" in pinned ? pinned.security_schemes?.[declared.scheme] : undefined;
  } else {
    apply = builtinSecurityScheme(declared.scheme as "oauth" | "bearer" | "basic" | "header", declared.header);
  }
  if (apply === undefined) throw new Error(`${server.name}: auth.scheme ${declared.scheme} names no scheme`);
  return { mode: declared.mode, scheme: declared.scheme, apply };
}

function build(
  name: string,
  upstream: readonly UpstreamTool[],
  pinned: McpLockSource | DefinitionLockSource,
): { lock: McpToolsLock; manifest: ManifestServer } {
  const server = valid(`servers/${name}/server.toml`, parseServerToml(read(`servers/${name}/server.toml`)));
  const tools = valid(`servers/${name}/tools.toml`, parseToolsToml(read(`servers/${name}/tools.toml`)));
  if (server.exposure.mode !== "direct") throw new Error(`${name}: search mode is not handled here`);

  const compiled = Object.entries(tools.tools ?? {}).map(([key, entry]) =>
    compileTool(server, tools, key, entry, upstream),
  );

  const lockTools: Record<string, McpToolsLock["tools"][string]> = {};
  const manifestTools: Record<string, ManifestTool> = {};
  for (const { key, upstream: source, tool } of compiled) {
    const locked = lockedUpstream(source);
    const upstream_hash = upstreamHash(locked);
    lockTools[key] = { definition_hash: tool.definition_hash, upstream: locked, upstream_hash, version: 1 } as McpToolsLock["tools"][string];
    manifestTools[key] = { ...tool, version: 1, upstream_hash };
  }
  const lock = mcpToolsLockSchema.parse({
    schema: "mcp-tools-lock/v1",
    server: name,
    source: pinned,
    tools: lockTools,
  });

  const definitions = Object.values(manifestTools).reduce((sum, tool) => sum + tool.tokens, 0);
  const manifest = manifestServerSchema.parse({
    name: server.name,
    label: server.label,
    description: server.description,
    source: server.source,
    pinned,
    auth: auth(server, pinned),
    environments: environments(server),
    exposure: {
      mode: server.exposure.mode,
      definition_budget: server.exposure.definition_budget ?? DEFAULT_SERVER_DEFINITION_BUDGET,
    },
    tokens: { definitions, request: definitions },
    search: null,
    tools: manifestTools,
  } satisfies ManifestServer);
  return { lock, manifest };
}

// ── stripe ───────────────────────────────────────────────────────────────────

const initialize = JSON.parse(read("sources/stripe/initialize.json")) as { serverInfo: { version: string } };
const toolsList = mcpToolsListResultSchema.parse(JSON.parse(read("sources/stripe/tools-list.json")));
const stripeUpstream = toolsList.tools.map(upstreamFromMcpTool);
const stripe = build("stripe", stripeUpstream, {
  type: "remote",
  url: "https://mcp.stripe.com",
  server_version: initialize.serverInfo.version,
});

// ── billing ──────────────────────────────────────────────────────────────────

const resolved = JSON.parse(read("sources/billing/resolved.json")) as { ref: string; commit: string };
const billingPinned: DefinitionLockSource = {
  type: "openapi",
  from: "repository",
  document_hash: documentHash(readFileSync(`${FIXTURES}servers/billing/openapi.yaml`)),
  repo: "github.com/a-intel/billing-service",
  path: "openapi/billing.yaml",
  ref: resolved.ref,
  commit: resolved.commit,
  security_schemes: billingSecuritySchemes,
};
const billing = build("billing", upstreamToolSchema.array().parse(billingUpstream), billingPinned);

// ── Write ────────────────────────────────────────────────────────────────────

write("servers/stripe/tools.lock.json", stripe.lock);
write("servers/billing/tools.lock.json", billing.lock);
write("expected/stripe/upstream.json", stripeUpstream);
write("expected/billing/upstream.json", billingUpstream);
write("expected/stripe/manifest.json", stripe.manifest);
write("expected/billing/manifest.json", billing.manifest);
write(
  "expected/tool-manifest.json",
  toolManifestSchema.parse({ schema: "tool-manifest/v1", servers: [billing.manifest, stripe.manifest] }),
);
