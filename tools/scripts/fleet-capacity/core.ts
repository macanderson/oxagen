import { createPublicKey, randomUUID } from "node:crypto";
import { GENESIS_CURSOR, sealEvent } from "../../../packages/tacho/src/chain";
import { digestBytes } from "../../../packages/tacho/src/digest";
import type { UnsealedTachoEvent } from "../../../packages/tacho/src/envelope";
import { verifyBundle } from "../../../packages/tacho/src/host/bundle";
import { newEventId, sessionUuid } from "../../../packages/tacho/src/ids";
import { TACHO_VERSION } from "../../../packages/tacho/src/version";
import {
  bundleResponseSchema, enrollmentResponseSchema, ingestResponseSchema, tachoBatchSchema,
  TACHO_BATCH_SCHEMA, TACHO_MAX_REQUEST_BYTES,
  type EnrollmentResponse, type TachoBatch,
} from "../../../packages/tacho/src/wire";

export interface Profile {
  schema: "fleet-capacity/v1";
  target: string;
  orgSlug: string;
  workspaceSlug: string;
  orgId: string;
  workspaceId: string;
  machines: number;
  baseline: {
    measured: boolean;
    sourceKind: "produced" | "received";
    source: string;
    sessionsPerSecond: number;
    samples: { turns: number; bodyBytes: number; weight: number }[];
  };
  phases: { seconds: number; multiplier: number }[];
  drainSeconds: number;
  maxQueueBytes: number;
  concurrency: number;
  ackP99Ms: number;
  controlP99Ms: number;
  ceilings: { sessions: number; events: number; bodyBytes: number; requests: number; networkBytes: number };
}

export interface WorkloadHost {
  hostEnrollmentId: string;
  agentKey: string;
  enrollment: { claims: { workspace_id: string; ingest_endpoint: string; bundle_endpoint: string } };
}

/** Require a staging DNS label and an independently supplied exact origin. */
export function stagingOrigin(value: string, trusted: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash ||
      !url.hostname.split(".").some((label) => label === "staging") ||
      url.origin !== trusted || value !== url.origin) {
    throw new Error("The target must be the exact trusted HTTPS staging origin.");
  }
  return url.origin;
}

function numberIn(value: number, min: number, max: number, integer = false): void {
  if (!Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isSafeInteger(value))) throw new Error("Profile number is outside its allowed range.");
}

export function validateProfile(value: Profile, trusted: string, live = false): Profile {
  stagingOrigin(value.target, trusted);
  if (value.schema !== "fleet-capacity/v1") throw new Error("Unknown fleet profile schema.");
  for (const slug of [value.orgSlug, value.workspaceSlug]) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error("Invalid tenant slug.");
  }
  for (const id of [value.orgId, value.workspaceId]) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Expected tenant UUIDs.");
  }
  numberIn(value.machines, 1, 500, true);
  numberIn(value.baseline.sessionsPerSecond, 0.000001, 1000);
  if (typeof value.baseline.measured !== "boolean" || !value.baseline.source ||
      (live && !value.baseline.measured)) throw new Error("Live load requires a measured baseline and its source.");
  if (!["produced", "received"].includes(value.baseline.sourceKind)) throw new Error("Label the baseline as produced or received load.");
  if (!Array.isArray(value.baseline.samples) || value.baseline.samples.length < 1 ||
      value.baseline.samples.length > 128) throw new Error("Provide 1 to 128 weighted baseline samples.");
  for (const sample of value.baseline.samples) {
    numberIn(sample.turns, 1, 30, true);
    numberIn(sample.bodyBytes, 0, 32768, true);
    numberIn(sample.weight, 1, 100000, true);
  }
  if (!Array.isArray(value.phases) || value.phases.length < 1 || value.phases.length > 16)
    throw new Error("Provide 1 to 16 load phases.");
  for (const phase of value.phases) {
    numberIn(phase.seconds, 1, 86400, true);
    numberIn(phase.multiplier, 1, 15000);
  }
  if (value.phases.reduce((sum, phase) => sum + phase.seconds, 0) > 90000)
    throw new Error("Load phases exceed 25 hours.");
  numberIn(value.drainSeconds, 1, 3600, true);
  numberIn(value.maxQueueBytes, TACHO_MAX_REQUEST_BYTES, 1024 ** 3, true);
  numberIn(value.concurrency, 1, 64, true);
  numberIn(value.ackP99Ms, 1, 60000);
  numberIn(value.controlP99Ms, 1, 60000);
  numberIn(value.ceilings.sessions, 1, 1000000000, true);
  numberIn(value.ceilings.events, 1, 100000000000, true);
  numberIn(value.ceilings.bodyBytes, 0, 10000000000000, true);
  numberIn(value.ceilings.requests, 1, 1000000000, true);
  numberIn(value.ceilings.networkBytes, 1, 100000000000000, true);
  const sessions = value.phases.reduce((sum, phase) => sum + Math.floor(
    value.baseline.sessionsPerSecond * phase.multiplier * phase.seconds), 0);
  const events = eventsInRange(value, 0, sessions);
  const maxBodyBytes = Math.max(...value.baseline.samples.map((sample) => sample.turns * sample.bodyBytes));
  if (sessions > value.ceilings.sessions || events > value.ceilings.events ||
      sessions * maxBodyBytes > value.ceilings.bodyBytes)
    throw new Error("The workload exceeds the configured session, event, or body-byte ceiling.");
  return value;
}

export function validateEnrollment(
  raw: unknown, profile: Profile, fingerprint: string, pinnedPublicKey: string,
): EnrollmentResponse {
  const response = enrollmentResponseSchema.parse(raw);
  if (response.apiKey.length > 4096 || response.agentKey.length > 256)
    throw new Error("Enrollment identity exceeds the generator's memory bound.");
  const claims = response.enrollment.claims;
  for (const [actual, expected] of [
    [claims.ingest_endpoint, `${profile.target}/v1/tacho/events`],
    [claims.bundle_endpoint, `${profile.target}/v1/tacho/bundle`],
    [claims.commands_endpoint, `${profile.target}/v1/tacho/commands`],
    [claims.organization_id, profile.orgId], [claims.workspace_id, profile.workspaceId],
    [claims.host_enrollment_id, response.hostEnrollmentId], [claims.agent_key, response.agentKey],
    [claims.device_key_fingerprint, fingerprint],
    [claims.issuer, "oxagen"], [claims.audience, "tacho-collector"],
  ]) {
    if (actual !== expected) throw new Error("Enrollment claims do not match the staging target or device.");
  }
  const now = Date.now() / 1000;
  if (claims.expires_at_unix_s <= now || claims.issued_at_unix_s > now + 60)
    throw new Error("Enrollment is expired or issued in the future.");
  const key = (pem: string) => createPublicKey(pem).export({ type: "spki", format: "der" });
  if (!key(response.bundlePublicKeyPem).equals(key(pinnedPublicKey)) ||
      !verifyBundle(response.policyBundle, pinnedPublicKey, response.hostEnrollmentId).ok)
    throw new Error("Enrollment bundle does not verify against the pinned staging key.");
  if (response.policyBundle.retention.mode !== "content_exact" ||
      !response.policyBundle.retention.classes.includes("model_call"))
    throw new Error("The staging mandate must retain model_call bodies for the evidence workload.");
  return response;
}

/** A probe without an etag must receive a signed policy for the requested host. */
export function validateControlBundle(raw: unknown, hostEnrollmentId: string, pinnedPublicKey: string): void {
  const response = bundleResponseSchema.parse(raw);
  if (response.not_modified || response.bundle === null || response.etag !== response.bundle.etag ||
      !verifyBundle(response.bundle, pinnedPublicKey, hostEnrollmentId).ok) {
    throw new Error("The control probe did not return a valid signed policy for its host.");
  }
}

export function sampleAt(profile: Profile, ordinal: number): Profile["baseline"]["samples"][number] {
  const samples = profile.baseline.samples;
  const total = samples.reduce((sum, sample) => sum + sample.weight, 0);
  let choice = ordinal % total;
  for (const sample of samples) {
    if (choice < sample.weight) return sample;
    choice -= sample.weight;
  }
  throw new Error("Missing workload sample.");
}

/** Sum skipped arrivals by whole weighted cycles, without iterating the backlog. */
export function eventsInRange(profile: Profile, first: number, count: number): number {
  const samples = profile.baseline.samples;
  const total = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const perCycle = samples.reduce((sum, sample) => sum + sample.weight * (2 + 5 * sample.turns), 0);
  const prefix = (n: number) => {
    let result = Math.floor(n / total) * perCycle;
    let remainder = n % total;
    for (const sample of samples) {
      const take = Math.min(remainder, sample.weight);
      result += take * (2 + 5 * sample.turns);
      remainder -= take;
    }
    return result;
  };
  return prefix(first + count) - prefix(first);
}

/** One sealed session per arrival. Each body contains synthetic repeated text. */
export function makeBatch(host: WorkloadHost, turns: number, bodyBytes: number, now: number): TachoBatch {
  const sessionId = randomUUID();
  const uuid = sessionUuid(host.hostEnrollmentId, sessionId);
  const bytes = Buffer.alloc(bodyBytes, 120);
  let cursor = GENESIS_CURSOR;
  const batch: TachoBatch = { schema: TACHO_BATCH_SCHEMA, host_enrollment_id: host.hostEnrollmentId, events: [], bodies: [] };
  const add = (kind: UnsealedTachoEvent["kind"], body: Record<string, unknown>, turn?: number, evidence = false) => {
    const draft = {
      v: "tacho/1.0", event_id: newEventId(now), session_id: sessionId,
      session_uuid: uuid, root_session_uuid: uuid, ts: new Date(now).toISOString(),
      fidelity: "sdk", source: kind === "llm_call" ? "otel_log" : "hook",
      agent: { agent_key: host.agentKey, fleet_id: host.enrollment.claims.workspace_id,
        runtime: "claude-code", harness: "claude-code", wrapper_version: TACHO_VERSION,
        host_enrollment_id: host.hostEnrollmentId },
      ...(turn === undefined ? {} : { turn: { turn_seq: turn, prompt_id: `p${turn}` } }),
      ...(evidence ? { content: { digest: digestBytes(bytes), redactions: [] } } : {}), kind, body,
    } as UnsealedTachoEvent;
    const sealed = sealEvent(draft, cursor);
    cursor = sealed.next;
    batch.events.push(sealed.event);
    if (evidence) batch.bodies?.push({ event_id_idem: sealed.event.event_id_idem,
      content_type: "text/plain; charset=utf-8", bytes_base64: bytes.toString("base64") });
  };
  add("agent_start", { model: "claude-haiku-4-5-20251001", session_start_source: "startup" });
  for (let turn = 1; turn <= turns; turn++) {
    add("turn_start", { prompt_length: bodyBytes }, turn, bodyBytes > 0);
    add("llm_call", { model: "claude-haiku-4-5-20251001", input_tokens: 10, output_tokens: 5, context_window: 200000 }, turn);
    add("tool_requested", { tool_name: "Read", tool_use_id: `tool_${turn}`, policy_decision: "allow" }, turn);
    add("tool_call", { tool_name: "Read", tool_use_id: `tool_${turn}`, tool_status: "ok", tool_duration_ms: 2 }, turn);
    add("turn_end", { last_assistant_message_digest: digestBytes("synthetic result") }, turn);
  }
  add("agent_stop", { session_outcome: "completed", session_end_reason: "other" });
  return tachoBatchSchema.parse(batch);
}

export function reconcile(batch: TachoBatch, raw: unknown): void {
  const ack = ingestResponseSchema.parse(raw);
  const wanted = new Set(batch.events.map((event) => event.event_id_idem));
  const received = new Set(ack.event_ids);
  if (ack.chain_breaks.length || ack.body_rejections?.length || ack.accepted !== wanted.size ||
      received.size !== wanted.size || ack.event_ids.length !== wanted.size ||
      [...received].some((id) => !wanted.has(id))) {
    throw new Error("Ingest acknowledgment failed event, chain, or body reconciliation.");
  }
}

/** Count all due arrivals without allocating work for an elapsed interval. */
export class ArrivalClock {
  private offered = 0;
  constructor(readonly rate: number, readonly start: number, readonly durationMs: number) {}
  due(now: number): { first: number; count: number } {
    const total = Math.floor(Math.min(Math.max(0, now - this.start), this.durationMs) * this.rate / 1000);
    const count = Math.max(0, total - this.offered);
    const first = this.offered;
    this.offered = total;
    return { first, count };
  }
}

/** Fixed logarithmic bins report upper bounds, not interpolated percentiles. */
export class Latency {
  private bins = Array<number>(27).fill(0);
  count = 0;
  maxMs = 0;
  add(ms: number): void {
    this.bins[Math.min(26, Math.ceil(Math.log2(Math.max(1, ms))))]!++;
    this.count++;
    this.maxMs = Math.max(this.maxMs, ms);
  }
  report() {
    const percentile = (p: number) => {
      if (!this.count) return null;
      let seen = 0;
      for (let i = 0; i < this.bins.length; i++) {
        seen += this.bins[i]!;
        if (seen >= Math.ceil(this.count * p)) return Math.min(2 ** i, this.maxMs);
      }
      return this.maxMs;
    };
    return { count: this.count, p50UpperMs: percentile(0.5), p95UpperMs: percentile(0.95), p99UpperMs: percentile(0.99), maxMs: this.maxMs };
  }
}
