// collectors/file.ts: read one work/collectors/<name>.toml into the fields
// work.collectors mirrors.
//
// The envelope below repeats packages/work/schemas/collector.v1.json, because
// @oxagen/ingestion does not depend on @oxagen/work. The [scope] table is the
// module's to check: when the type's module is registered, its config schema
// reads the scope, and a scope it refuses fails the file.
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { getCollector } from "./registry";
import type { CollectorType } from "./types";

/** The directory in the steering repo that holds collector files. */
export const COLLECTOR_FILE_DIR = "work/collectors";

/** The schema id every collector file names. */
export const COLLECTOR_FILE_SCHEMA = "collector/v1";

/** Keep in step with COLLECTOR_TYPES in @oxagen/work. */
export const COLLECTOR_TYPE_VALUES = [
  "github",
  "jira",
  "linear",
  "zendesk",
  "servicenow",
  "salesforce",
  "slack",
  "email",
] as const satisfies readonly CollectorType[];

/** Keep in step with COLLECTOR_TYPES_WITHOUT_WRITE_BACK in @oxagen/work. */
export const COLLECTOR_TYPES_WITHOUT_WRITE_BACK: readonly CollectorType[] = [
  "slack",
  "email",
];

/** The one type with no connection: Oxagen assigns the address. */
const COLLECTOR_TYPES_WITHOUT_CONNECTION: readonly CollectorType[] = ["email"];

/** The [write_back] switches, in the order the spec lists them. */
export const WRITE_BACK_SWITCHES = [
  "certify_note",
  "send_note",
  "status",
  "close",
  "labels",
] as const;

export type WriteBackSwitch = (typeof WRITE_BACK_SWITCHES)[number];

export type WriteBackSwitches = Record<WriteBackSwitch, boolean>;

/**
 * The switches a collector file leaves out. Keep in step with
 * WRITE_BACK_DEFAULTS in @oxagen/work: the certify note and the send note
 * are on, and status, close, and labels are off (agent-work-spec.html,
 * Write-back). A type with no write-back reads every switch as off.
 */
export const WRITE_BACK_DEFAULTS: Readonly<WriteBackSwitches> = Object.freeze({
  certify_note: true,
  send_note: true,
  status: false,
  close: false,
  labels: false,
});

const WRITE_BACK_OFF: Readonly<WriteBackSwitches> = Object.freeze({
  certify_note: false,
  send_note: false,
  status: false,
  close: false,
  labels: false,
});

const slug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use lowercase words joined by single hyphens");

const uniqueStrings = z
  .array(z.string().min(1))
  .refine((values) => new Set(values).size === values.length, {
    message: "list each value once",
  });

const envelope = z
  .object({
    schema: z.literal(COLLECTOR_FILE_SCHEMA),
    name: slug,
    label: z.string().min(1).max(120),
    type: z.enum(COLLECTOR_TYPE_VALUES),
    connection: z.string().min(1).optional(),
    scope: z.record(z.unknown()),
    defaults: z
      .object({ labels: uniqueStrings.optional(), workflow: slug.optional() })
      .strict()
      .optional(),
    write_back: z
      .object({
        certify_note: z.boolean().optional(),
        send_note: z.boolean().optional(),
        status: z.boolean().optional(),
        close: z.boolean().optional(),
        labels: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const needsConnection = !COLLECTOR_TYPES_WITHOUT_CONNECTION.includes(
      file.type,
    );
    if (needsConnection && file.connection === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connection"],
        message: `a ${file.type} collector names its connection`,
      });
    if (!needsConnection && file.connection !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connection"],
        message: `a ${file.type} collector has no connection`,
      });
    if (
      COLLECTOR_TYPES_WITHOUT_WRITE_BACK.includes(file.type) &&
      file.write_back !== undefined
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["write_back"],
        message: `a ${file.type} collector has no write-back`,
      });
  });

/** One collector file, read and checked. */
export interface CollectorFile {
  /** The path in the steering repo, such as `work/collectors/inbox.toml`. */
  path: string;
  name: string;
  label: string;
  type: CollectorType;
  /** The connection id the file names. Null for email. */
  connection: string | null;
  /** The [scope] table as the file wrote it. */
  scope: Record<string, unknown>;
  defaults: { labels: string[]; workflow: string | null };
  /** Every switch, with the defaults filled in. */
  writeBack: WriteBackSwitches;
  /** `sha256:<hex>` over the file's text, byte for byte. */
  fileHash: string;
}

export type CollectorFileResult =
  | { ok: true; file: CollectorFile }
  | { ok: false; path: string; errors: string[] };

/** `sha256:<hex>` over the text as UTF-8. */
export function collectorFileHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The collector name a path gives: the file name without `.toml`. */
export function collectorNameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".toml") ? base.slice(0, -".toml".length) : base;
}

/** True for a path directly in work/collectors/ that ends in `.toml`. */
export function isCollectorFilePath(path: string): boolean {
  const prefix = `${COLLECTOR_FILE_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".toml")) return false;
  return !path.slice(prefix.length).includes("/");
}

/** The switches in force for a type, from the file's [write_back] table. */
export function resolveWriteBack(
  type: CollectorType,
  table: Partial<WriteBackSwitches> | undefined,
): WriteBackSwitches {
  if (COLLECTOR_TYPES_WITHOUT_WRITE_BACK.includes(type))
    return { ...WRITE_BACK_OFF };
  return { ...WRITE_BACK_DEFAULTS, ...(table ?? {}) };
}

/**
 * The switches a work.collectors row stores in its write_back column. Only a
 * switch stored as true is on. A missing or malformed value reads off, never
 * as the file's default, so a row that lost its switches writes nothing to
 * the provider (#4775).
 */
export function readStoredWriteBack(
  type: CollectorType,
  stored: unknown,
): WriteBackSwitches {
  const switches: WriteBackSwitches = { ...WRITE_BACK_OFF };
  if (COLLECTOR_TYPES_WITHOUT_WRITE_BACK.includes(type)) return switches;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored))
    return switches;
  for (const name of WRITE_BACK_SWITCHES)
    switches[name] = name in stored && Reflect.get(stored, name) === true;
  return switches;
}

function issuesOf(error: z.ZodError, prefix: string[] = []): string[] {
  return error.issues.map((issue) => {
    const path = [...prefix, ...issue.path];
    return path.length > 0 ? `${path.join(".")}: ${issue.message}` : issue.message;
  });
}

/**
 * Read one collector file. The name must match the file name, and when the
 * type's module is registered, its config must accept the [scope] table.
 */
export function readCollectorFile(
  path: string,
  text: string,
): CollectorFileResult {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    return {
      ok: false,
      path,
      errors: [`not valid TOML: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success)
    return { ok: false, path, errors: issuesOf(parsed.error) };
  const data = parsed.data;
  const errors: string[] = [];
  const expected = collectorNameFromPath(path);
  if (data.name !== expected)
    errors.push(`name: ${data.name} does not match the file name ${expected}`);
  const collectorModule = getCollector(data.type);
  if (collectorModule) {
    const scope = collectorModule.config.safeParse(data.scope);
    if (!scope.success) errors.push(...issuesOf(scope.error, ["scope"]));
  }
  if (errors.length > 0) return { ok: false, path, errors };
  return {
    ok: true,
    file: {
      path,
      name: data.name,
      label: data.label,
      type: data.type,
      connection: data.connection ?? null,
      scope: data.scope,
      defaults: {
        labels: data.defaults?.labels ?? [],
        workflow: data.defaults?.workflow ?? null,
      },
      writeBack: resolveWriteBack(data.type, data.write_back),
      fileHash: collectorFileHash(text),
    },
  };
}
