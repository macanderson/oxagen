// Steering mappers: a published context record row → the SteeringRecord view
// model (spec §9–§10). Pure: no I/O, no clock.
//
// Where each field comes from (column level, confirmed against
// packages/database/src/schema/agent.ts):
//
//   lineage      ← the `[[record]].lineage_id` of the active version's body,
//                  which must equal agent.context_records.slug (the file stem)
//   kind         ← `[[record]].kind`
//   force        ← `[[record]].steering.force`
//   enforcement  ← null: context-record/v0.1 carries an enforcement MODE
//                  (hard/soft/none), not a require/forbid effect
//   scope        ← `[[record]].sharing_scope`, else `[defaults].sharing_scope`
//   status       ← agent.context_records.status (the promotions ledger drives
//                  it): active → published; retired, superseded → archived
//   statement    ← `[[record]].statement`
//   effect       ← null: effect metrics are M3
//   commitSha    ← the active version's provenance entry of type `commit`
//                  (agent.context_record_versions.provenance, ContextProvenanceV1)
//   publishedOn  ← the latest `promote` entry in agent.context_promotions for
//                  the active version, else context_record_versions.published_at
//
// A row the view model cannot carry is never dropped and never padded: it maps
// to a failure that names the field, and the adapter turns the set into an
// honest read result (readSteeringRecords below).
import type { schema } from "@oxagen/database";
import { z } from "zod";
import { Day } from "@/data/contracts/common";
import { SteeringRecord } from "@/data/contracts/steering";
import {
  NO_GAP,
  type Read,
  notBacked,
  readError,
  readOk,
} from "@/data/not-backed";

// ---- context-record/v0.1 TOML ----------------------------------------------
//
// The subset of TOML a record file uses: comments, `[table]` and `[[array]]`
// headers, dotted and quoted keys, basic and literal strings (single and
// multi-line), arrays, inline tables, and bare scalars. Strings are decoded;
// numbers, booleans and dates are kept as raw scalars, because no steering field
// reads one. Anything else is a TomlSubsetError, never a guess.
//
// The body is tenant-authored (publish_context_record) and read in the shared
// server process, so the reader is hardened against prototype pollution: every
// table is a null-prototype object, existing keys are looked up as own
// properties only, and `__proto__`, `constructor` and `prototype` are refused as
// keys anywhere (headers, dotted keys, inline tables). Nesting is capped so a
// hostile body cannot exhaust the stack.

export class TomlSubsetError extends Error {
  readonly code = "toml_subset_invalid";
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${String(offset)}`);
    this.name = "TomlSubsetError";
  }
}

export type TomlScalar = { readonly scalar: string };
export type TomlValue = string | TomlScalar | TomlValue[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

const BARE_KEY = /[A-Za-z0-9_-]/;
/** Keys that would reach Object.prototype through a plain property write. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
/** Deepest array / inline-table nesting a record file may use. */
export const MAX_TOML_NESTING = 32;
const ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

/** A fresh table: no prototype, so no key can reach Object.prototype. */
const newTable = (): TomlTable => Object.create(null) as TomlTable;

/**
 * Tables are the only null-prototype values the reader makes; a scalar is a
 * plain object. A table that happens to have a `scalar` key stays a table.
 */
const isTable = (v: unknown): v is TomlTable =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === null;

/** An own key of a table, never an inherited one. */
const own = (table: TomlTable, key: string): TomlValue | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

class TomlReader {
  private i = 0;
  private depth = 0;
  constructor(private readonly src: string) {}

  read(): TomlTable {
    const root = newTable();
    let current = root;
    for (;;) {
      this.skipBlank();
      if (this.i >= this.src.length) return root;
      if (this.src[this.i] === "[") {
        current = this.header(root);
      } else {
        this.keyValue(current);
      }
      this.endOfLine();
    }
  }

  private fail(message: string): never {
    throw new TomlSubsetError(message, this.i);
  }

  /** Whitespace, newlines and comments. */
  private skipBlank(): void {
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (c === "#") this.skipComment();
      else return;
    }
  }

  private skipInline(): void {
    while (this.src[this.i] === " " || this.src[this.i] === "\t") this.i++;
  }

  private skipComment(): void {
    while (this.i < this.src.length && this.src[this.i] !== "\n") this.i++;
  }

  private endOfLine(): void {
    this.skipInline();
    if (this.src[this.i] === "#") this.skipComment();
    const c = this.src[this.i];
    if (c === undefined || c === "\n" || c === "\r") return;
    this.fail("expected end of line");
  }

  private header(root: TomlTable): TomlTable {
    const isArray = this.src.startsWith("[[", this.i);
    this.i += isArray ? 2 : 1;
    this.skipInline();
    const path = this.keyPath();
    this.skipInline();
    const close = isArray ? "]]" : "]";
    if (!this.src.startsWith(close, this.i)) this.fail("unclosed table header");
    this.i += close.length;

    let table = root;
    path.forEach((segment, index) => {
      const last = index === path.length - 1;
      const existing = own(table, segment);
      if (last && isArray) {
        const next = newTable();
        if (existing === undefined) table[segment] = [next];
        else if (Array.isArray(existing)) existing.push(next);
        else this.fail(`key "${segment}" is not an array of tables`);
        table = next;
        return;
      }
      if (existing === undefined) {
        const next = newTable();
        table[segment] = next;
        table = next;
      } else if (Array.isArray(existing)) {
        // `[record.steering]` after `[[record]]` names the latest element.
        const tail = existing.at(-1);
        if (!isTable(tail)) this.fail(`key "${segment}" is not a table`);
        table = tail;
      } else if (isTable(existing)) {
        table = existing;
      } else {
        this.fail(`key "${segment}" is not a table`);
      }
    });
    return table;
  }

  private keyPath(): string[] {
    const path = [this.key()];
    for (;;) {
      this.skipInline();
      if (this.src[this.i] !== ".") return path;
      this.i++;
      this.skipInline();
      path.push(this.key());
    }
  }

  private key(): string {
    const start = this.i;
    const c = this.src[this.i];
    let key: string;
    if (c === '"' || c === "'") {
      key = this.string();
    } else {
      while (this.i < this.src.length && BARE_KEY.test(this.src[this.i] ?? ""))
        this.i++;
      if (this.i === start) this.fail("expected a key");
      key = this.src.slice(start, this.i);
    }
    if (RESERVED_KEYS.has(key)) {
      this.i = start;
      this.fail("reserved key");
    }
    return key;
  }

  private keyValue(table: TomlTable): void {
    const path = this.keyPath();
    this.skipInline();
    if (this.src[this.i] !== "=") this.fail("expected '='");
    this.i++;
    this.skipInline();
    const value = this.value();
    let target = table;
    for (const segment of path.slice(0, -1)) {
      const existing = own(target, segment);
      if (existing === undefined) {
        const next = newTable();
        target[segment] = next;
        target = next;
      } else if (isTable(existing)) {
        target = existing;
      } else {
        this.fail(`key "${segment}" is not a table`);
      }
    }
    const leaf = path.at(-1) ?? this.fail("expected a key");
    if (Object.hasOwn(target, leaf)) this.fail(`duplicate key "${leaf}"`);
    target[leaf] = value;
  }

  private value(): TomlValue {
    const c = this.src[this.i];
    if (c === '"' || c === "'") return this.string();
    if (c === "[" || c === "{") {
      if (this.depth >= MAX_TOML_NESTING) this.fail("nesting too deep");
      this.depth++;
      const nested = c === "[" ? this.array() : this.inlineTable();
      this.depth--;
      return nested;
    }
    const start = this.i;
    while (
      this.i < this.src.length &&
      !/[\s,\]}#]/.test(this.src[this.i] ?? "")
    )
      this.i++;
    if (this.i === start) this.fail("expected a value");
    return { scalar: this.src.slice(start, this.i) };
  }

  private array(): TomlValue[] {
    this.i++;
    const items: TomlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.src[this.i] === "]") {
        this.i++;
        return items;
      }
      items.push(this.value());
      this.skipBlank();
      if (this.src[this.i] === ",") this.i++;
      else if (this.src[this.i] !== "]") this.fail("expected ',' or ']'");
    }
  }

  private inlineTable(): TomlTable {
    this.i++;
    const table = newTable();
    this.skipInline();
    if (this.src[this.i] === "}") {
      this.i++;
      return table;
    }
    for (;;) {
      this.skipInline();
      this.keyValue(table);
      this.skipInline();
      if (this.src[this.i] === "}") {
        this.i++;
        return table;
      }
      if (this.src[this.i] !== ",") this.fail("expected ',' or '}'");
      this.i++;
    }
  }

  private string(): string {
    const quote = this.src[this.i] ?? "";
    const multi = this.src.startsWith(quote.repeat(3), this.i);
    const delimiter = multi ? quote.repeat(3) : quote;
    this.i += delimiter.length;
    // A newline right after an opening multi-line delimiter is trimmed.
    if (multi && this.src[this.i] === "\r") this.i++;
    if (multi && this.src[this.i] === "\n") this.i++;
    let out = "";
    for (;;) {
      if (this.i >= this.src.length) this.fail("unterminated string");
      if (this.src.startsWith(delimiter, this.i)) {
        this.i += delimiter.length;
        return out;
      }
      const c = this.src[this.i] ?? "";
      if (!multi && c === "\n") this.fail("newline in a single-line string");
      if (quote === '"' && c === "\\") {
        out += this.escape(multi);
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private escape(multi: boolean): string {
    const next = this.src[this.i + 1] ?? "";
    if (multi && /[\s]/.test(next)) {
      // A line-ending backslash trims the newline and the leading whitespace.
      this.i++;
      while (/\s/.test(this.src[this.i] ?? "")) this.i++;
      return "";
    }
    const simple = ESCAPES[next];
    if (simple !== undefined) {
      this.i += 2;
      return simple;
    }
    if (next === "u" || next === "U") {
      const width = next === "u" ? 4 : 8;
      const hex = this.src.slice(this.i + 2, this.i + 2 + width);
      if (!new RegExp(`^[0-9A-Fa-f]{${String(width)}}$`).test(hex))
        this.fail("invalid unicode escape");
      this.i += 2 + width;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    this.fail("invalid escape");
  }
}

/** Parse the TOML subset a context-record file uses. Throws TomlSubsetError. */
export function parseRecordToml(source: string): TomlTable {
  return new TomlReader(source).read();
}

// ---- record rows -------------------------------------------------------------

type ContextRecordSelect = typeof schema.contextRecords.$inferSelect;
type ContextRecordVersionSelect =
  typeof schema.contextRecordVersions.$inferSelect;

/** One workspace record joined to its active version and its promotion date. */
export type ContextRecordRow = Pick<
  ContextRecordSelect,
  "publicId" | "slug" | "status"
> &
  Pick<ContextRecordVersionSelect, "body" | "provenance"> & {
    /** context_record_versions.published_at of the active version. */
    versionPublishedAt: Date | null;
    /** created_at of the latest `promote` ledger entry for the active version. */
    promotedAt: Date | string | null;
  };

/** Why a row cannot be shown as a SteeringRecord. */
export type RecordGap =
  /** The stored body is not a readable context-record/v0.1 record for this slug. */
  | "invalid"
  /** The body is valid, but a field the view model requires was never recorded. */
  | "unrepresentable";

export type RecordMapping =
  | { ok: true; record: SteeringRecord }
  | { ok: false; gap: RecordGap; recordId: string; field: string };

export const RECORD_SCHEMA = "context-record/v0.1";

/** The error a read carries when a stored record body cannot be read. */
export const RECORD_BODY_INVALID = "record_body_invalid";

const STATUS: Record<string, SteeringRecord["status"]> = {
  active: "published",
  retired: "archived",
  superseded: "archived",
};

const SharingScope = z.enum([
  "user",
  "repository",
  "workspace",
  "organization",
]);

const ProvenanceEntry = z.object({
  type: z.string(),
  digest: z.string().optional(),
});

/** The commit a version was published from: its `commit` provenance entry. */
export function commitFromProvenance(provenance: unknown): string | null {
  const entries = z.array(z.unknown()).safeParse(provenance);
  if (!entries.success) return null;
  for (const entry of entries.data) {
    const parsed = ProvenanceEntry.safeParse(entry);
    if (parsed.success && parsed.data.type === "commit" && parsed.data.digest)
      return parsed.data.digest.toLowerCase();
  }
  return null;
}

function toDay(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

const str = (table: TomlTable | undefined, key: string): string | undefined => {
  const v = table ? own(table, key) : undefined;
  return typeof v === "string" ? v : undefined;
};
const sub = (
  table: TomlTable | undefined,
  key: string,
): TomlTable | undefined => {
  const v = table ? own(table, key) : undefined;
  return isTable(v) ? v : undefined;
};

/** Map one row. Never throws: a row that cannot map says which field and why. */
export function toSteeringRecord(row: ContextRecordRow): RecordMapping {
  const fail = (gap: RecordGap, field: string): RecordMapping => ({
    ok: false,
    gap,
    recordId: row.publicId,
    field,
  });

  let file: TomlTable;
  try {
    file = parseRecordToml(row.body);
  } catch (err) {
    if (err instanceof TomlSubsetError) return fail("invalid", "body");
    throw err;
  }
  if (own(file, "schema") !== RECORD_SCHEMA) return fail("invalid", "schema");

  const listed = own(file, "record");
  const records = Array.isArray(listed) ? listed.filter(isTable) : [];
  const record = records.find((r) => own(r, "lineage_id") === row.slug);
  if (!record) return fail("invalid", "lineage_id");

  const defaults = sub(file, "defaults");
  const rawScope =
    own(record, "sharing_scope") ??
    (defaults ? own(defaults, "sharing_scope") : undefined);
  if (rawScope === undefined) return fail("unrepresentable", "sharing_scope");
  const scope = SharingScope.safeParse(rawScope);
  if (!scope.success) return fail("invalid", "sharing_scope");
  if (scope.data !== "workspace" && scope.data !== "repository")
    return fail("unrepresentable", "sharing_scope");

  const force = str(sub(record, "steering"), "force");
  if (force === undefined) return fail("unrepresentable", "force");

  const status = Object.hasOwn(STATUS, row.status)
    ? STATUS[row.status]
    : undefined;
  if (!status) return fail("invalid", "status");

  const commitSha = commitFromProvenance(row.provenance);
  if (commitSha === null) return fail("unrepresentable", "commitSha");

  const publishedOn = toDay(row.promotedAt) ?? toDay(row.versionPublishedAt);
  if (publishedOn === null || !Day.safeParse(publishedOn).success)
    return fail("unrepresentable", "publishedOn");

  const parsed = SteeringRecord.safeParse({
    lineage: own(record, "lineage_id"),
    kind: str(record, "kind"),
    force,
    enforcement: null,
    scope: scope.data,
    status,
    statement: str(record, "statement"),
    effect: null,
    commitSha,
    publishedOn,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "record";
    return fail("invalid", field);
  }
  return { ok: true, record: parsed.data };
}

/**
 * The read result for a workspace's records. Every row must map, or the set is
 * not shown: an invalid stored body is an error the page names, and a field
 * that is not recorded yet (the publication commit arrives with Context PRs,
 * M3) is `not_backed`. A partial list would read as the whole steering set.
 */
export function readSteeringRecords(
  rows: readonly ContextRecordRow[],
): Read<SteeringRecord[]> {
  const mapped = rows.map(toSteeringRecord);
  const failures = mapped.filter((m) => !m.ok);
  if (failures.some((f) => f.gap === "invalid"))
    return readError(RECORD_BODY_INVALID, 502);
  if (failures.length > 0) return notBacked("M3", NO_GAP);
  return readOk(mapped.flatMap((m) => (m.ok ? [m.record] : [])));
}
