// The SCIM 2.0 wire format (RFC 7643, RFC 7644) that Oxagen serves, kept free
// of storage so each rule is testable on its own: schema ids, errors, list
// responses, the one filter shape identity providers send, and PATCH
// operations in the shapes Okta and Microsoft Entra ID actually send them.

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_SPC_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCIM_RESOURCE_TYPE_SCHEMA =
  "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCIM_SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

/** The largest page a list answers, and the default when none is asked for. */
export const SCIM_MAX_RESULTS = 200;
export const SCIM_DEFAULT_COUNT = 100;

export type ScimType =
  | "invalidFilter"
  | "invalidValue"
  | "invalidSyntax"
  | "invalidPath"
  | "mutability"
  | "uniqueness"
  | "noTarget";

/**
 * A refusal the endpoint answers with a SCIM error body. `denial` marks the
 * refusals that are also a `scim.request_denied` audit row.
 */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimType,
    readonly denial?:
      | "owner_protected"
      | "domain_not_verified"
      | "identity_not_owned"
      | "cross_organization"
      | "not_entitled"
      | "invalid_token",
  ) {
    super(detail);
    this.name = "ScimError";
  }
}

export function scimErrorBody(err: ScimError): Record<string, unknown> {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(err.status),
    ...(err.scimType ? { scimType: err.scimType } : {}),
    detail: err.detail,
  };
}

export function listResponse(
  resources: readonly unknown[],
  totalResults: number,
  startIndex: number,
): Record<string, unknown> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

const MAX_START_INDEX = 2_147_483_647;

/** `startIndex` and `count` from the query, clamped to what the spec allows. */
export function pageOf(query: Record<string, string>): {
  startIndex: number;
  count: number;
} {
  const start = Number.parseInt(query.startIndex ?? "1", 10);
  const count = Number.parseInt(query.count ?? String(SCIM_DEFAULT_COUNT), 10);
  return {
    // Clamped to a 32-bit offset, so a huge startIndex answers an empty page
    // rather than overflowing the query's OFFSET.
    startIndex:
      Number.isFinite(start) && start >= 1 ? Math.min(start, MAX_START_INDEX) : 1,
    count: Number.isFinite(count)
      ? Math.min(Math.max(count, 0), SCIM_MAX_RESULTS)
      : SCIM_DEFAULT_COUNT,
  };
}

export interface ScimEqFilter {
  /** The attribute, lowercased: `username`, `externalid`, `displayname`, `emails.value`, `id`. */
  attribute: string;
  value: string;
}

const FILTER_RE = /^\s*([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

/**
 * Parse the one filter identity providers send: `<attribute> eq "<value>"`.
 * Okta looks a user up by `userName eq "…"` before creating one, and Entra ID
 * by `userName eq` or `externalId eq`; both look groups up by `displayName eq`.
 * Anything else is `invalidFilter`, which is the answer the spec gives for an
 * unsupported expression. Attribute names compare case-insensitively.
 */
export function parseEqFilter(
  filter: string | undefined,
  allowed: readonly string[],
): ScimEqFilter | null {
  if (filter === undefined || filter.trim() === "") return null;
  const match = FILTER_RE.exec(filter);
  if (!match) {
    throw new ScimError(
      400,
      'Only filters of the form attribute eq "value" are supported',
      "invalidFilter",
    );
  }
  const attribute = match[1]!.toLowerCase();
  if (!allowed.includes(attribute)) {
    throw new ScimError(
      400,
      `Filtering on ${match[1]} is not supported`,
      "invalidFilter",
    );
  }
  return { attribute, value: match[2]!.replace(/\\(.)/g, "$1") };
}

/**
 * A SCIM boolean. Entra ID has sent `"True"` and `"False"` as strings, so a
 * string spelling of either is accepted, case-insensitively.
 */
export function scimBoolean(value: unknown, attribute: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  throw new ScimError(400, `${attribute} must be a boolean`, "invalidValue");
}

export interface PatchOperation {
  op: "add" | "replace" | "remove";
  /** The path as sent, or undefined for a value-object operation. */
  path?: string;
  value?: unknown;
}

/**
 * Read a PatchOp body into operations with a lowercase `op`. Entra ID sends
 * `"Replace"` and `"Add"`; the spec says `op` is case-insensitive.
 */
export function readPatch(body: unknown): PatchOperation[] {
  if (typeof body !== "object" || body === null) {
    throw new ScimError(400, "The PATCH body must be a PatchOp", "invalidSyntax");
  }
  const operations = (body as { Operations?: unknown; operations?: unknown })
    .Operations ?? (body as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) {
    throw new ScimError(
      400,
      "The PATCH body must carry an Operations array",
      "invalidSyntax",
    );
  }
  return operations.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ScimError(400, "Each operation must be an object", "invalidSyntax");
    }
    const { op, path, value } = raw as {
      op?: unknown;
      path?: unknown;
      value?: unknown;
    };
    const lower = typeof op === "string" ? op.toLowerCase() : "";
    if (lower !== "add" && lower !== "replace" && lower !== "remove") {
      throw new ScimError(
        400,
        `Unsupported PATCH op ${String(op)}`,
        "invalidSyntax",
      );
    }
    if (path !== undefined && typeof path !== "string") {
      throw new ScimError(400, "A PATCH path must be a string", "invalidPath");
    }
    return {
      op: lower,
      ...(path !== undefined ? { path } : {}),
      ...(value !== undefined ? { value } : {}),
    };
  });
}

/**
 * The member id a `members[value eq "…"]` path names, which is how Okta and
 * Entra ID remove one member from a group. Null for any other path.
 */
export function memberFilterValue(path: string): string | null {
  const match = /^members\s*\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(
    path.trim(),
  );
  return match ? match[1]! : null;
}

/** The ids in a `members` value: `[{ value }]`, or one `{ value }`. */
export function memberIds(value: unknown): string[] {
  const list: unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : value === undefined
      ? []
      : [value];
  return list.map((m) => {
    const id: unknown =
      typeof m === "object" && m !== null
        ? (m as { value?: unknown }).value
        : m;
    if (typeof id !== "string" || id === "") {
      throw new ScimError(400, "Each member needs a value", "invalidValue");
    }
    return id;
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isScimId(value: string): boolean {
  return UUID_RE.test(value);
}

export function serviceProviderConfig(baseUrl: string): Record<string, unknown> {
  return {
    schemas: [SCIM_SPC_SCHEMA],
    documentationUri: "https://docs.oxagen.sh/governance/sso",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description:
          "The organization's SCIM token, minted on Organization › Single sign-on.",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${baseUrl}/ServiceProviderConfig`,
    },
  };
}

export function resourceTypes(baseUrl: string): Record<string, unknown>[] {
  return [
    {
      schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
      id: "User",
      name: "User",
      endpoint: "/Users",
      schema: SCIM_USER_SCHEMA,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` },
    },
    {
      schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: SCIM_GROUP_SCHEMA,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/Group` },
    },
  ];
}

const attr = (
  name: string,
  type: string,
  extra: Record<string, unknown> = {},
) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

/** The core User and Group schemas, cut to the attributes Oxagen stores. */
export function schemas(baseUrl: string): Record<string, unknown>[] {
  return [
    {
      schemas: [SCIM_SCHEMA_SCHEMA],
      id: SCIM_USER_SCHEMA,
      name: "User",
      description: "A person in the organization",
      attributes: [
        attr("userName", "string", { required: true, uniqueness: "server" }),
        attr("externalId", "string", { caseExact: true }),
        attr("displayName", "string"),
        {
          ...attr("name", "complex"),
          subAttributes: [
            attr("formatted", "string"),
            attr("givenName", "string"),
            attr("familyName", "string"),
          ],
        },
        {
          ...attr("emails", "complex", { multiValued: true }),
          subAttributes: [
            attr("value", "string"),
            attr("type", "string"),
            attr("primary", "boolean"),
          ],
        },
        attr("active", "boolean"),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM_USER_SCHEMA}` },
    },
    {
      schemas: [SCIM_SCHEMA_SCHEMA],
      id: SCIM_GROUP_SCHEMA,
      name: "Group",
      description:
        "A group from the identity provider. It decides an organization role only through the SSO group mapping.",
      attributes: [
        attr("displayName", "string", { required: true, uniqueness: "server" }),
        attr("externalId", "string", { caseExact: true }),
        {
          ...attr("members", "complex", { multiValued: true }),
          subAttributes: [
            attr("value", "string", { mutability: "immutable" }),
            attr("display", "string", { mutability: "readOnly" }),
          ],
        },
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM_GROUP_SCHEMA}` },
    },
  ];
}

/**
 * Postgres unique_violation (23505), as the driver throws it or as Drizzle
 * wraps it in `cause`: two writes raced for one name, email or live token.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, cause } = err as { code?: unknown; cause?: { code?: unknown } };
  return code === "23505" || cause?.code === "23505";
}
