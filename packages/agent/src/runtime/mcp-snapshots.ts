// mcp-snapshots.ts — external MCP tool-descriptor snapshots, descriptor
// pinning, + server-change audit.
//
// At registration (and on re-enable) every discovered tool's JSONSchema
// descriptor is captured into mcp.tool_snapshots so replay of an old run can
// render the tool even after the server is disabled or deleted. Every
// enable/disable/delete lands an immutable audit row in
// security.mcp_server_changes.
//
// The snapshots double as DESCRIPTOR PINS: the runtime contributor
// (plugin-types/mcp.ts) diffs each live tool descriptor against its newest
// snapshot and only exposes tools whose live descriptor exactly matches the
// pin — the pinned descriptor, never the live one, is what reaches the model.
// A drifted or never-pinned descriptor is excluded for the turn (fail closed)
// and audited as a `drift_detected` server change. This is the enforcement
// that makes an external MCP server's post-registration description rewrite
// (the classic tool-poisoning rug-pull) inert.

import { createHash } from "node:crypto";
import { withTenantDb, schema } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import type { McpToolDescriptor } from "../dispatch/mcp-client";

export interface CaptureSnapshotArgs {
  orgId: string;
  workspaceId: string;
  mcpServerId: string;
  descriptors: McpToolDescriptor[];
  createdByUserId?: string | null;
}

/**
 * Write one snapshot row per discovered tool. Each call appends a new
 * captured_at version — older rows are preserved so a replayed run renders the
 * descriptor as it was when the run happened. Returns the number of rows written.
 */
export async function captureToolSnapshots(
  args: CaptureSnapshotArgs,
): Promise<number> {
  if (args.descriptors.length === 0) return 0;
  const values = args.descriptors.map((d) => ({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    mcpServerId: args.mcpServerId,
    toolName: d.name,
    // Store the full descriptor (name + description + inputSchema) so a replay
    // can reconstruct the tool card without the server.
    schemaJson: {
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    } as object,
    createdByUserId: args.createdByUserId ?? null,
  }));
  await withTenantDb((tx) => tx.insert(schema.mcpToolSnapshots).values(values));
  return values.length;
}

/**
 * Read the latest descriptor snapshot for each (server, tool) — the replay
 * lookup. Returns the most recent capture per tool name.
 */
export async function readLatestSnapshots(
  orgId: string,
  workspaceId: string,
  mcpServerId: string,
): Promise<
  Array<{ toolName: string; schemaJson: unknown; capturedAt: string }>
> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        toolName: schema.mcpToolSnapshots.toolName,
        schemaJson: schema.mcpToolSnapshots.schemaJson,
        capturedAt: schema.mcpToolSnapshots.capturedAt,
      })
      .from(schema.mcpToolSnapshots)
      .where(
        and(
          eq(schema.mcpToolSnapshots.orgId, orgId),
          eq(schema.mcpToolSnapshots.workspaceId, workspaceId),
          eq(schema.mcpToolSnapshots.mcpServerId, mcpServerId),
        ),
      )
      .orderBy(desc(schema.mcpToolSnapshots.capturedAt)),
  );
  // Collapse to the newest row per tool name.
  const seen = new Set<string>();
  const out: Array<{
    toolName: string;
    schemaJson: unknown;
    capturedAt: string;
  }> = [];
  for (const r of rows) {
    if (seen.has(r.toolName)) continue;
    seen.add(r.toolName);
    out.push({
      toolName: r.toolName,
      schemaJson: r.schemaJson,
      capturedAt: r.capturedAt.toISOString(),
    });
  }
  return out;
}

// ── Descriptor pinning ───────────────────────────────────────────────────────

// Deterministic JSON encoding: object keys sorted recursively, arrays kept in
// order, `undefined` members dropped. Two semantically-identical descriptors
// that differ only in key order (e.g. the DB jsonb round-trip reorders keys)
// must hash identically, otherwise every pin would false-positive as drift.
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`)
    .join(",")}}`;
}

/**
 * Content hash of a tool descriptor (name + description + inputSchema) over
 * its canonical JSON form. This is the pin identity: a live descriptor is
 * trusted iff its hash equals the hash of its newest snapshot.
 */
export function descriptorHash(d: McpToolDescriptor): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        name: d.name,
        description: d.description ?? null,
        inputSchema: d.inputSchema ?? {},
      }),
    )
    .digest("hex");
}

export interface DescriptorPinVerdict {
  /**
   * Live tools whose descriptor exactly matches their pin. Each entry is the
   * PINNED descriptor (not the live one) — callers must inject these, so even
   * a hash-collision-adjacent bug can never leak live text to the model.
   */
  pinned: McpToolDescriptor[];
  /** Tool names advertised live whose descriptor differs from the pin. */
  drifted: string[];
  /** Tool names advertised live that have no pin on record. */
  unpinned: string[];
  /** Pinned tool names the server no longer advertises. */
  missing: string[];
}

/**
 * Diff the live tool listing against the pinned snapshots. Pure — no I/O.
 * Fail-closed semantics: only exact hash matches land in `pinned`; everything
 * else is classified for exclusion + audit. A tool name advertised more than
 * once live is a descriptor-confusion attempt and is classified as drifted.
 */
export function diffDescriptorsAgainstPins(
  live: McpToolDescriptor[],
  pins: McpToolDescriptor[],
): DescriptorPinVerdict {
  const pinByName = new Map(pins.map((p) => [p.name, p] as const));
  const liveCounts = new Map<string, number>();
  for (const t of live)
    liveCounts.set(t.name, (liveCounts.get(t.name) ?? 0) + 1);

  const pinned: McpToolDescriptor[] = [];
  const drifted: string[] = [];
  const unpinned: string[] = [];
  const seen = new Set<string>();
  for (const t of live) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    const pin = pinByName.get(t.name);
    if (!pin) {
      unpinned.push(t.name);
      continue;
    }
    if (
      (liveCounts.get(t.name) ?? 0) > 1 ||
      descriptorHash(t) !== descriptorHash(pin)
    ) {
      drifted.push(t.name);
      continue;
    }
    pinned.push(pin);
  }
  const liveNames = new Set(live.map((t) => t.name));
  const missing = pins.filter((p) => !liveNames.has(p.name)).map((p) => p.name);
  return { pinned, drifted, unpinned, missing };
}

// Parse one snapshot row's schema_json back into a McpToolDescriptor. Strict:
// a malformed or name-mismatched row returns null, so the corresponding live
// tool classifies as unpinned and is excluded (fail closed) rather than being
// matched against a fabricated pin.
function parseSnapshotDescriptor(
  json: unknown,
  toolName: string,
): McpToolDescriptor | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.name !== toolName) return null;
  const inputSchema =
    o.inputSchema &&
    typeof o.inputSchema === "object" &&
    !Array.isArray(o.inputSchema)
      ? (o.inputSchema as Record<string, unknown>)
      : {};
  return {
    name: toolName,
    description: typeof o.description === "string" ? o.description : null,
    inputSchema,
  };
}

/**
 * The newest pinned descriptor per tool for a server, parsed and validated.
 * Rows that fail to parse are omitted — their live counterparts then classify
 * as unpinned in diffDescriptorsAgainstPins and are excluded (fail closed).
 */
export async function readLatestPinnedDescriptors(
  orgId: string,
  workspaceId: string,
  mcpServerId: string,
): Promise<McpToolDescriptor[]> {
  const rows = await readLatestSnapshots(orgId, workspaceId, mcpServerId);
  const out: McpToolDescriptor[] = [];
  for (const r of rows) {
    const parsed = parseSnapshotDescriptor(r.schemaJson, r.toolName);
    if (parsed) out.push(parsed);
  }
  return out;
}

export type McpServerChangeType =
  | "enable"
  | "disable"
  | "delete"
  | "drift_detected";

export interface RecordServerChangeArgs {
  orgId: string;
  workspaceId: string;
  serverId: string;
  changeType: McpServerChangeType;
  actorUserId?: string | null;
}

/**
 * Append an immutable audit row to security.mcp_server_changes. Written on
 * every enable / disable / delete of an external MCP server, and on every
 * turn where descriptor drift was detected and failed closed (drift_detected).
 */
export async function recordServerChange(
  args: RecordServerChangeArgs,
): Promise<void> {
  await withTenantDb((tx) =>
    tx.insert(schema.mcpServerChanges).values({
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      serverId: args.serverId,
      changeType: args.changeType,
      actorUserId: args.actorUserId ?? null,
    }),
  );
}
