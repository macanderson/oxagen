import { z } from "zod";
import { registerCapability } from "../registry";
import { BUILTIN_SERVER, SERVER_NAME_PATTERN } from "../steering-repo/names";
import {
  impactSchema,
  toolEgressClassSchema,
  toolRiskGradeSchema,
  toolSideEffectClassSchema,
} from "./tool.classification";

/**
 * Studio's draft (lane M11, ADR-224): the edits a person stages on one server
 * folder before Review opens a steering PR. Oxagen keeps the draft in
 * `mcp.studio_drafts` so it survives a reload and a second tab. A draft holds
 * no credential. server.toml names a credential by reference, and a saved test
 * keeps the request as built before the gateway adds the credential.
 *
 * The shapes here mirror Studio's own (apps/app/src/features/mcp-studio/
 * draft.ts). This package cannot import `@oxagen/mcp-studio`, which depends on
 * it, so the MCP tool list and the lock source are typed loosely here. The
 * handler parses both with the steering repo's own schemas and refuses what
 * does not parse.
 */

/** The most edits one draft holds. */
export const STUDIO_DRAFT_OPS_MAX = 2000;
/**
 * The largest list of edits one draft holds, in UTF-8 bytes of its JSON: 8
 * MiB. The count alone lets 2,000 saved tests reach more than a gigabyte.
 */
export const STUDIO_DRAFT_OPS_BYTES_MAX = 8 * 1024 * 1024;
/**
 * server.toml's largest size in a draft, in UTF-8 bytes: 256 KiB. The table
 * checks the same limit with octet_length.
 */
export const STUDIO_SERVER_TOML_MAX = 256 * 1024;
/**
 * The largest source a draft holds, in UTF-8 bytes: DEFINITION_BYTES_MAX in
 * `@oxagen/mcp-studio`, 25 MiB.
 */
export const STUDIO_SOURCE_BYTES_MAX = 25 * 1024 * 1024;
/**
 * The largest save request the API reads, in bytes: 36 MiB. It holds the
 * source, the edits, and server.toml at their limits, with room for the JSON
 * around them. The API refuses a larger body before it parses it.
 */
export const STUDIO_DRAFT_BODY_BYTES_MAX = 36 * 1024 * 1024;
/** The most tools one server's tool list carries. */
export const STUDIO_SOURCE_TOOLS_MAX = 2000;
/** The most files one definition carries. */
export const STUDIO_SOURCE_FILES_MAX = 500;

/** The folder name under tools/servers/, which is the server's name. */
export const studioServerNameSchema = z
  .string()
  .regex(
    SERVER_NAME_PATTERN,
    "a server name starts with a letter and has at most 24 lowercase letters, digits, and underscores",
  )
  .refine((name) => name !== BUILTIN_SERVER, {
    message: `${BUILTIN_SERVER} is reserved for Oxagen's built-in tools`,
  });

/** A tool as Studio names it: its tools.toml key, or the upstream name it selects. */
export const studioToolNameSchema = z.string().min(1).max(128);
const toolSchema = studioToolNameSchema;

/**
 * The largest result cap tools.toml takes, in bytes: `MAX_RESULT_BYTES_LIMIT`
 * in `@oxagen/mcp-studio`, 1 MiB. This package cannot import that one.
 */
export const STUDIO_MAX_RESULT_BYTES = 1_048_576;

/** One staged edit. Studio's DraftOp, field for field. */
export const studioDraftOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("import"), tool: toolSchema }).strict(),
  z.object({ kind: z.literal("remove"), tool: toolSchema }).strict(),
  z
    .object({
      kind: z.literal("classify"),
      tool: toolSchema,
      risk: toolRiskGradeSchema,
      sideEffect: toolSideEffectClassSchema,
      egress: toolEgressClassSchema,
      impacts: z.array(impactSchema).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("describe"),
      tool: toolSchema,
      description: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("test"),
      tool: toolSchema,
      environment: z.string().min(1).max(64),
      /** The arguments as the person typed them: a JSON object. */
      args: z.string().max(65_536),
      /** The request as built before the credential was added: one recorded request, as JSON. */
      request: z.string().max(65_536),
      /** The upstream's answer, unshaped: one recorded response, as JSON. */
      raw: z.string().max(262_144),
      /** What the model would receive after shaping: the recorded result, as JSON. */
      shaped: z.string().max(262_144),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cap"),
      tool: toolSchema,
      /** tools.toml's `max_result_bytes`: the result's size cap after select and redact. */
      maxResultBytes: z.number().int().min(1).max(STUDIO_MAX_RESULT_BYTES),
      /**
       * True sets tools.toml's `paginate` to the paging pattern import found
       * for the tool, and false removes it. Absent leaves it as it is.
       */
      paging: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("expose"),
      /**
       * server.toml's `[exposure] mode`: `direct` sends every tool definition
       * on every request, and `search` sends the server's three search tools.
       */
      mode: z.enum(["direct", "search"]),
    })
    .strict(),
]);
export type StudioDraftOp = z.output<typeof studioDraftOpSchema>;

const definitionFileSchema = z
  .object({
    /** Relative to the server's folder: openapi.yaml, proto/ledger/v1/ledger.proto. */
    path: z.string().min(1).max(512),
    text: z.string(),
  })
  .strict();

/** The 40- or 64-character commit a repository definition resolved to. */
const commitSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "a commit is 40 or 64 lowercase hex characters");

/**
 * What the draft imports from: the server's tool list for an MCP server, or
 * the definition for an OpenAPI, GraphQL, or gRPC server. Review imports it
 * again, so the PR is built from inputs rather than from Studio's view.
 */
export const studioSourceSchema = z.union([
  z
    .object({
      type: z.literal("mcp"),
      /** tools.lock.json's source: remote, registry, or local, in the lock's snake case. */
      lockSource: z.record(z.unknown()),
      /** The server's tools/list result, one MCP tool each. */
      tools: z.array(z.record(z.unknown())).max(STUDIO_SOURCE_TOOLS_MAX),
    })
    .strict(),
  z
    .object({
      type: z.literal("openapi"),
      files: z.array(definitionFileSchema).min(1).max(STUDIO_SOURCE_FILES_MAX),
      /** The root document's path among files. */
      entry: z.string().min(1).max(512),
      /** An OpenAPI Overlay 1.0 to apply, written to overlay.yaml. */
      overlay: z.string().min(1).optional(),
      commit: commitSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("graphql"),
      sdl: z.string().min(1),
      commit: commitSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("graphql"),
      /** The data of an introspection query result: { __schema }. */
      introspection: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal("grpc"),
      /** The .proto files under proto/, with the files they import. */
      files: z.array(definitionFileSchema).min(1).max(STUDIO_SOURCE_FILES_MAX),
      commit: commitSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("grpc"),
      /** Serialized FileDescriptorProto messages from server reflection, base64. */
      reflection: z.array(z.string().min(1)).min(1).max(STUDIO_SOURCE_FILES_MAX),
    })
    .strict(),
]);
export type StudioSource = z.output<typeof studioSourceSchema>;

const UTF8 = new TextEncoder();

/** A string's size in UTF-8 bytes, the unit Postgres's octet_length counts. */
function utf8Bytes(text: string): number {
  return UTF8.encode(text).length;
}

/** The UTF-8 size of a source as the draft stores it. */
export function studioSourceBytes(source: StudioSource): number {
  return utf8Bytes(JSON.stringify(source));
}

/** A draft as Oxagen holds it. The source is summarized, never echoed. */
export const studioDraftSchema = z.object({
  server: z.string(),
  /** `mcs_…` of the registered server, or null for a server not yet registered. */
  serverId: z.string().nullable(),
  ops: z.array(studioDraftOpSchema),
  /** server.toml as Studio authored it, or null to keep the production file. */
  serverToml: z.string().nullable(),
  source: z
    .object({
      type: z.enum(["mcp", "openapi", "graphql", "grpc"]),
      bytes: z.number().int().min(0),
    })
    .nullable(),
  /** Rises by one on every save. Pass it back to refuse a save over a newer one. */
  revision: z.number().int().min(1),
  /** The steering PR Review opened from this draft, or null before Review. */
  pr: z
    .object({
      number: z.number().int().positive(),
      url: z.string().url(),
      branch: z.string(),
    })
    .nullable(),
  updatedAt: z.string(),
});
export type StudioDraft = z.output<typeof studioDraftSchema>;

/**
 * The input's base object, before the size rule: MCP tools spread `.shape`
 * for their argument schema, and a refined schema has none. `invoke()`
 * re-parses the refined contract input, so the rule still holds on a call.
 */
export const toolStudioDraftSaveInputObject = z
  .object({
    /** The folder name under tools/servers/. */
    server: studioServerNameSchema,
    /** `mcs_…` of the registered server. Omit for a server not yet registered. */
    serverId: z.string().min(1).max(64).optional(),
    /** Every staged edit. The list replaces the stored one. */
    ops: z.array(studioDraftOpSchema).max(STUDIO_DRAFT_OPS_MAX),
    /**
     * server.toml as Studio authored it. Omit to keep the stored one. The
     * length cap counts UTF-16 units, and the save's size rule counts UTF-8
     * bytes, the unit the table checks.
     */
    serverToml: z.string().min(1).max(STUDIO_SERVER_TOML_MAX).optional(),
    /** What the draft imports from. Omit to keep the stored one. */
    source: studioSourceSchema.optional(),
    /**
     * The revision this save builds on: 0 for a new draft. A save over a
     * different revision is refused with `conflict`. Omit to save over any.
     */
    revision: z.number().int().min(0).optional(),
  })
  .strict();

export const toolStudioDraftSave = registerCapability({
  name: "save_studio_draft",
  domain: "tool",
  description:
    "Save Studio's staged edits to one server folder as a draft: tools to import or remove, their classification, description, result cap, and paging, saved tests, the server's exposure mode, server.toml, and the definition or tool list they import from. The draft holds no credential, and Review opens a steering PR from it.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // A draft is governance work and spends no model tokens.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "governance" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  audit: { targetKind: "tool_server_folder", targetIdField: "server" },
  input: toolStudioDraftSaveInputObject.superRefine((input, ctx) => {
    const opsBytes = utf8Bytes(JSON.stringify(input.ops));
    if (opsBytes > STUDIO_DRAFT_OPS_BYTES_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ops"],
        message: `the edits are ${opsBytes} bytes, and a draft holds at most ${STUDIO_DRAFT_OPS_BYTES_MAX}`,
      });
    }
    if (input.serverToml !== undefined) {
      const bytes = utf8Bytes(input.serverToml);
      if (bytes > STUDIO_SERVER_TOML_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["serverToml"],
          message: `server.toml is ${bytes} bytes, and a draft holds at most ${STUDIO_SERVER_TOML_MAX}`,
        });
      }
    }
    if (input.source !== undefined) {
      const bytes = studioSourceBytes(input.source);
      if (bytes > STUDIO_SOURCE_BYTES_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source"],
          message: `the source is ${bytes} bytes, and a draft holds at most ${STUDIO_SOURCE_BYTES_MAX}`,
        });
      }
    }
  }),
  output: studioDraftSchema,
});

export type ToolStudioDraftSaveInput = z.output<typeof toolStudioDraftSave.input>;
export type ToolStudioDraftSaveOutput = z.output<typeof toolStudioDraftSave.output>;
