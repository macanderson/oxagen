// manifest.ts: a ManifestTool, a ManifestServer, and a CredentialSource for
// execute()'s tests. Only the fields execute() reads are real.
import type {
  ManifestAuth,
  ManifestClassification,
  ManifestEnvironment,
  ManifestServer,
  ManifestShaping,
  ManifestTool,
} from "../../contract/manifest";
import type { Paging, RequestTemplate } from "../../model/upstream-tool";
import type { CredentialRequest, CredentialSource, ResolvedCredential } from "../credentials";
import { shaping } from "./fake-http";

export interface ToolOptions {
  name?: string;
  request?: RequestTemplate;
  /** The inputSchema's properties. */
  properties?: Record<string, unknown>;
  required?: string[];
  shaping?: Partial<ManifestShaping>;
  paging?: Paging;
}

/** An HTTP GET of /charges with a query parameter for each name. */
export function listRequest(query: readonly string[]): RequestTemplate {
  return {
    kind: "http",
    operation: "listCharges",
    method: "GET",
    path: "/charges",
    parameters: query.map((name) => ({ name, in: "query" as const, property: name, required: false })),
  };
}

export function manifestTool(options: ToolOptions = {}): ManifestTool {
  const name = options.name ?? "list_charges";
  const inputSchema: ManifestTool["definition"]["inputSchema"] = {
    type: "object",
    properties: options.properties ?? {},
  };
  if (options.required !== undefined) inputSchema.required = options.required;
  const tool: ManifestTool = {
    name,
    version: 1,
    definition_hash: `sha256:${"a".repeat(64)}`,
    upstream_hash: `sha256:${"b".repeat(64)}`,
    definition: {
      name: `billing__${name}`,
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    tokens: 10,
    classification: {} as unknown as ManifestClassification,
    shaping: shaping(options.shaping),
    request: options.request ?? listRequest([]),
  };
  if (options.paging !== undefined) tool.paging = options.paging;
  return tool;
}

export const SANDBOX: ManifestEnvironment = {
  sandbox: true,
  url: "https://api.example.com/v2",
  network: "cloud",
  credential: "billing-sandbox",
};

export interface ServerOptions {
  auth?: ManifestAuth | null;
  environments?: Record<string, ManifestEnvironment>;
  pinned?: Record<string, unknown>;
}

export function manifestServer(options: ServerOptions = {}): ManifestServer {
  const server = {
    name: "billing",
    label: "Billing",
    description: "The billing API.",
    source: { type: "openapi" },
    pinned: options.pinned ?? { type: "openapi" },
    auth: options.auth === undefined ? null : options.auth,
    environments: options.environments ?? { sandbox: SANDBOX },
    exposure: { mode: "direct", definition_budget: 8000 },
    tokens: { definitions: 10, request: 10 },
    search: null,
    tools: {},
  };
  return server as unknown as ManifestServer;
}

export const BEARER_AUTH: ManifestAuth = { mode: "service", scheme: "bearer", apply: { type: "http_bearer" } };

export interface FakeCredentials {
  source: CredentialSource;
  requests: CredentialRequest[];
}

/** A CredentialSource that answers every request with this credential. */
export function fakeCredentials(credential: ResolvedCredential = { type: "bearer", token: "tok_never_recorded" }): FakeCredentials {
  const requests: CredentialRequest[] = [];
  return {
    requests,
    source: {
      resolve: (request) => {
        requests.push(request);
        return Promise.resolve(credential);
      },
    },
  };
}
