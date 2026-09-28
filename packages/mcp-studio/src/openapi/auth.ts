// auth.ts: the auth choices and environments a document offers.
//
// Each entry of components.securitySchemes becomes a SuggestedAuth that
// server.toml's auth.scheme can name. Each entry of servers becomes a
// SuggestedEnvironment. An entry import cannot express leaves a note.
import { httpUrlSchema } from "../contract/primitives";
import { parseEndpoint } from "../execute/endpoint";
import { BuildError } from "../execute/util";
import type {
  ImportNote,
  SuggestedAuth,
  SuggestedEnvironment,
} from "../model/import-result";
import {
  securitySchemeSchema,
  type SecurityScheme,
} from "../model/security-scheme";
import {
  isList,
  isRecord,
  recordField,
  stringField,
  type JsonRecord,
} from "./json";
import type { Resolver } from "./resolve";

/** The OAuth flows, in the order import reads their URLs. */
const FLOWS = [
  "authorizationCode",
  "implicit",
  "clientCredentials",
  "password",
] as const;

const SCOPES_MAX = 256;

function note(notes: ImportNote[], message: string): void {
  notes.push({ tool: undefined, message });
}

function absoluteUrl(
  value: unknown,
  what: string,
  scheme: string,
  notes: ImportNote[],
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (httpUrlSchema.safeParse(value).success) return value;
  note(
    notes,
    `Import dropped the ${what} of the security scheme ${scheme}, because "${value}" is not an absolute http or https URL.`,
  );
  return undefined;
}

function oauth(
  name: string,
  scheme: JsonRecord,
  notes: ImportNote[],
): SecurityScheme {
  const flows = recordField(scheme, "flows") ?? {};
  const read = (flow: (typeof FLOWS)[number]): JsonRecord | undefined =>
    recordField(flows, flow);
  const first = (
    field: string,
    order: readonly (typeof FLOWS)[number][],
  ): unknown => {
    for (const flow of order) {
      const value = read(flow)?.[field];
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const result: SecurityScheme = { type: "oauth2" };
  const authorization = absoluteUrl(
    first("authorizationUrl", ["authorizationCode", "implicit"]),
    "authorization URL",
    name,
    notes,
  );
  if (authorization !== undefined) result.authorization_url = authorization;
  const token = absoluteUrl(
    first("tokenUrl", ["authorizationCode", "clientCredentials", "password"]),
    "token URL",
    name,
    notes,
  );
  if (token !== undefined) result.token_url = token;
  const refresh = absoluteUrl(
    first("refreshUrl", FLOWS),
    "refresh URL",
    name,
    notes,
  );
  if (refresh !== undefined && refresh !== token) result.refresh_url = refresh;

  // A set answers "seen already?" in constant time, so a document offering
  // many scopes costs one pass. An array lookup per scope made it quadratic.
  // Only the first SCOPES_MAX are kept, and the set counts the rest for the note.
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const flow of FLOWS) {
    const offered = recordField(read(flow) ?? {}, "scopes") ?? {};
    for (const scope of Object.keys(offered)) {
      if (scope.length === 0 || scope.length > 256) {
        note(
          notes,
          `Import dropped a scope of the security scheme ${name}, because a scope name is 1 to 256 characters.`,
        );
      } else if (!seen.has(scope)) {
        seen.add(scope);
        if (scopes.length < SCOPES_MAX) scopes.push(scope);
      }
    }
  }
  if (seen.size > SCOPES_MAX) {
    note(
      notes,
      `The security scheme ${name} offers ${seen.size} scopes. Import kept the first ${SCOPES_MAX}.`,
    );
  }
  if (scopes.length > 0) result.scopes = scopes;
  return result;
}

/** One entry of components.securitySchemes as a SecurityScheme, or undefined with a note. */
function readScheme(
  name: string,
  scheme: JsonRecord,
  notes: ImportNote[],
): SecurityScheme | undefined {
  const type = stringField(scheme, "type");
  switch (type) {
    case "oauth2":
      return oauth(name, scheme, notes);
    case "openIdConnect": {
      const url = absoluteUrl(
        scheme.openIdConnectUrl,
        "OpenID Connect URL",
        name,
        notes,
      );
      if (url === undefined) {
        note(
          notes,
          `Import skipped the security scheme ${name}, because it has no absolute openIdConnectUrl.`,
        );
        return undefined;
      }
      return { type: "openIdConnect", openid_connect_url: url };
    }
    case "http": {
      const httpScheme = stringField(scheme, "scheme")?.toLowerCase();
      if (httpScheme === "bearer") return { type: "http_bearer" };
      if (httpScheme === "basic") return { type: "http_basic" };
      note(
        notes,
        `Import skipped the security scheme ${name}, because the gateway sends HTTP bearer and basic credentials only, ` +
          `and it uses ${httpScheme ?? "no scheme"}.`,
      );
      return undefined;
    }
    case "apiKey": {
      const where = stringField(scheme, "in");
      const header = stringField(scheme, "name");
      if (
        (where === "header" || where === "query" || where === "cookie") &&
        header !== undefined
      ) {
        return { type: "api_key", in: where, name: header };
      }
      note(
        notes,
        `Import skipped the security scheme ${name}, because an apiKey scheme needs a name and an in of header, query, or cookie.`,
      );
      return undefined;
    }
    case "mutualTLS":
      return { type: "mutual_tls" };
    default:
      note(
        notes,
        `Import skipped the security scheme ${name}, because its type ${type ?? "(none)"} is not one OpenAPI defines.`,
      );
      return undefined;
  }
}

/** The auth choices the document offers: each entry of components.securitySchemes. */
export function readAuth(
  document: JsonRecord,
  resolver: Resolver,
  notes: ImportNote[],
): SuggestedAuth[] {
  const schemes =
    recordField(recordField(document, "components") ?? {}, "securitySchemes") ??
    {};
  const auth: SuggestedAuth[] = [];
  for (const [name, raw] of Object.entries(schemes)) {
    const scheme = resolver.resolveObject(raw);
    if (!isRecord(scheme)) {
      note(
        notes,
        `Import skipped the security scheme ${name}, because it is not a mapping.`,
      );
      continue;
    }
    const read = readScheme(name, scheme, notes);
    if (read === undefined) continue;
    const parsed = securitySchemeSchema.safeParse(read);
    if (!parsed.success) {
      note(
        notes,
        `Import skipped the security scheme ${name}: ${parsed.error.issues[0]?.message ?? "it is not valid"}.`,
      );
      continue;
    }
    auth.push({ scheme: name, ...parsed.data });
  }
  return auth;
}

/** The server URL with each {variable} replaced by its default. */
function expandServerUrl(url: string, server: JsonRecord): string {
  const variables = recordField(server, "variables") ?? {};
  return url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const variable = variables[name];
    const fallback = isRecord(variable) ? variable.default : undefined;
    return typeof fallback === "string" ? fallback : whole;
  });
}

/** Why the executor refuses url as an API's base url, or undefined when it accepts it. */
function baseUrlRefusal(url: string): string | undefined {
  try {
    parseEndpoint(url, "base");
    return undefined;
  } catch (error) {
    if (error instanceof BuildError) return error.message;
    throw error;
  }
}

/** The environments the document suggests: each absolute URL in servers the executor can call. */
export function readEnvironments(
  document: JsonRecord,
  notes: ImportNote[],
): SuggestedEnvironment[] {
  const servers = isList(document.servers) ? document.servers : [];
  const environments: SuggestedEnvironment[] = [];
  for (const server of servers) {
    if (!isRecord(server)) continue;
    const raw = stringField(server, "url");
    if (raw === undefined) continue;
    const url = expandServerUrl(raw, server);
    if (!httpUrlSchema.safeParse(url).success) {
      note(
        notes,
        `Import skipped the server "${raw}", because it is not an absolute http or https URL. ` +
          "Set the environment's url in server.toml.",
      );
      continue;
    }
    // The executor reads an environment's url as a base url, and refuses a
    // query, a fragment, and an IPv6 host. Offering one would fail every call.
    const refusal = baseUrlRefusal(url);
    if (refusal !== undefined) {
      note(
        notes,
        `Import skipped the server "${raw}", because a tool call cannot use it as a base url. ${refusal} ` +
          "Set the environment's url in server.toml.",
      );
      continue;
    }
    if (environments.some((environment) => environment.url === url)) continue;
    environments.push({ url, description: stringField(server, "description") });
  }
  return environments;
}
