import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyChain } from "../../../packages/tacho/src/chain";
import { digestBytes } from "../../../packages/tacho/src/digest";
import { bundleSigner, unsignedBundle, TEST_ENROLLMENT } from "../../../packages/tacho/src/host/test-support";
import { deviceKeyFingerprint } from "../../../packages/tacho/src/host/device-key";
import type { EnrollmentResponse, TachoBatch } from "../../../packages/tacho/src/wire";
import example from "./profile.example.json";
import { ArrivalClock, Latency, eventsInRange, makeBatch, reconcile, stagingOrigin, validateControlBundle, validateEnrollment, validateProfile, type Profile } from "./core";
import { compare, stagingStore } from "./reconcile";
import { postJson, runFleet } from "./run";

const profile = example as Profile;
const signer = bundleSigner();
function host(): EnrollmentResponse {
  return {
    hostEnrollmentId: TEST_ENROLLMENT, agentKey: "capacity.capacity.cc-fixture",
    apiKeyPublicId: "fixture-key", apiKey: "fixture-secret",
    enrollment: { signature_hex: "0".repeat(64), verification_secret_env: "TACHO_ENROLLMENT_SIGNING_SECRET",
      claims: { schema: "oxagen.tacho.host-enrollment.v1", issuer: "oxagen", audience: "tacho-collector",
        host_enrollment_id: TEST_ENROLLMENT, organization_id: profile.orgId, workspace_id: profile.workspaceId,
        agent_key: "capacity.capacity.cc-fixture", device_key_fingerprint: "fixture",
        ingest_endpoint: `${profile.target}/v1/tacho/events`, bundle_endpoint: `${profile.target}/v1/tacho/bundle`,
        commands_endpoint: `${profile.target}/v1/tacho/commands`, credential_env: "OXAGEN_TACHO_HOST_KEY",
        harnesses: ["claude-code"], issued_at_unix_s: Math.floor(Date.now() / 1000),
        expires_at_unix_s: Math.floor(Date.now() / 1000) + 86400 } },
    policyBundle: signer.sign(unsignedBundle({ retention: { mode: "content_exact", classes: ["model_call"] } })),
    bundlePublicKeyPem: signer.publicKeyPem, expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
}
function ack(batch: TachoBatch) {
  return { accepted: batch.events.length, event_ids: batch.events.map((event) => event.event_id_idem),
    chain_breaks: [], body_rejections: [], control: { host_status: "active",
      deny_generation: { org: 1, workspace: 1 }, bundle_etag: "fixture", commands: [] } };
}
function bundleAnswer() {
  const bundle = host().policyBundle;
  return { not_modified: false, etag: bundle.etag, bundle };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("fleet capacity boundaries", () => {
  it.each(["https://api.oxagen.sh", "https://api.oxagen.app", "https://staging.oxagen.sh.evil.test",
    "http://api.staging.oxagen.sh", `${profile.target}/v1`, `${profile.target}?redirect=production`])("refuses %s", (target) => {
    expect(() => stagingOrigin(target, profile.target)).toThrow();
  });
  it("refuses live defaults and workload ceilings before any request", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); vi.stubEnv("FLEET_STAGING_ORIGIN", profile.target);
    await expect(runFleet(profile, "/unused", "secret", signer.publicKeyPem)).rejects.toThrow(/measured/);
    const excessive = { ...profile, baseline: { ...profile.baseline, measured: true, sessionsPerSecond: 1000 } };
    expect(() => validateProfile(excessive, profile.target, true)).toThrow(/ceiling/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks exact signed endpoints, tenant, device, and pinned policy signature", () => {
    const original = host();
    expect(validateEnrollment(original, profile, "fixture", signer.publicKeyPem)).toEqual(original);
    for (const field of ["ingest_endpoint", "bundle_endpoint", "commands_endpoint"] as const) {
      const changed = structuredClone(original);
      changed.enrollment.claims[field] = "https://api.oxagen.sh/v1/tacho/events";
      expect(() => validateEnrollment(changed, profile, "fixture", signer.publicKeyPem)).toThrow(/claims/);
    }
    expect(() => validateEnrollment(original, profile, "another-device", signer.publicKeyPem)).toThrow(/claims/);
    expect(() => validateEnrollment(original, profile, "fixture", bundleSigner().publicKeyPem)).toThrow(/pinned/);
  });
  it("requires a usable signed control policy for the requested host", () => {
    const answer = bundleAnswer();
    expect(() => validateControlBundle(answer, TEST_ENROLLMENT, signer.publicKeyPem)).not.toThrow();
    expect(() => validateControlBundle({ ...answer, not_modified: true, bundle: null },
      TEST_ENROLLMENT, signer.publicKeyPem)).toThrow();
    expect(() => validateControlBundle({ ...answer, etag: "other" },
      TEST_ENROLLMENT, signer.publicKeyPem)).toThrow();
    expect(() => validateControlBundle(answer, "tch_anotherhost", signer.publicKeyPem)).toThrow();
    expect(() => validateControlBundle(answer, TEST_ENROLLMENT, bundleSigner().publicKeyPem)).toThrow();
    const forged = structuredClone(answer);
    forged.bundle.signature.sig = Buffer.alloc(64).toString("base64");
    expect(() => validateControlBundle(forged, TEST_ENROLLMENT, signer.publicKeyPem)).toThrow();
  });
  it("produces sealed synthetic sessions with matching body digests", () => {
    const batch = makeBatch(host(), 30, 32768, Date.now());
    expect(batch.events).toHaveLength(152);
    expect(verifyChain(batch.events).ok).toBe(true);
    expect(batch.bodies).toHaveLength(30);
    for (const body of batch.bodies!) {
      expect(batch.events.find((event) => event.event_id_idem === body.event_id_idem)?.content?.digest)
        .toBe(digestBytes(Buffer.from(body.bytes_base64, "base64")));
    }
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(4 * 1024 * 1024);
  });
  it("accepts exact replay receipts and refuses missing events, duplicates, or body rejection", () => {
    const batch = makeBatch(host(), 1, 16, Date.now());
    const answer = ack(batch);
    expect(() => reconcile(batch, answer)).not.toThrow();
    expect(() => reconcile(batch, { ...answer, event_ids: answer.event_ids.slice(1) })).toThrow();
    expect(() => reconcile(batch, { ...answer, event_ids: [...answer.event_ids.slice(1), answer.event_ids[1]] })).toThrow();
    expect(() => reconcile(batch, { ...answer, body_rejections: [{ event_id_idem: answer.event_ids[0], reason: "digest" }] })).toThrow();
  });
  it("counts a large clock jump and skipped weighted cycles without allocating arrivals", () => {
    const clock = new ArrivalClock(15000000, 0, 86400000);
    expect(clock.due(86400000)).toEqual({ first: 0, count: 1296000000000 });
    expect(clock.due(86400001).count).toBe(0);
    const varied = { ...profile, baseline: { ...profile.baseline, samples: [
      { turns: 1, bodyBytes: 0, weight: 2 }, { turns: 3, bodyBytes: 0, weight: 1 }] } };
    expect(eventsInRange(varied, 1, 6)).toBe(62);
    expect(eventsInRange(varied, 0, 3000000000)).toBe(31000000000);
  });
  it("keeps fixed latency bins and names percentile upper bounds", () => {
    const latency = new Latency();
    expect(latency.report().p99UpperMs).toBeNull();
    latency.add(3); latency.add(10);
    expect(latency.report()).toMatchObject({ count: 2, p50UpperMs: 4, p99UpperMs: 10 });
  });
  it("keeps HTTP retries byte-identical and disables redirects", async () => {
    const request = JSON.stringify(makeBatch(host(), 1, 16, Date.now()));
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await expect(postJson(`${profile.target}/v1/tacho/events`, "secret", request)).rejects.toThrow(/503/);
    await postJson(`${profile.target}/v1/tacho/events`, "secret", request);
    expect(fetcher.mock.calls.map((call) => call[1].body)).toEqual([request, request]);
    expect(fetcher.mock.calls.every((call) => call[1].redirect === "error")).toBe(true);
  });
  it("cancels oversized response bodies", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel,
    }))));
    await expect(postJson(profile.target, "secret", "{}")).rejects.toThrow(/2 MiB/);
    expect(cancel).toHaveBeenCalled();
  });
  it("pins database hosts and refuses durable or derived discrepancies", () => {
    expect(() => stagingStore("postgres://db.production.example/test", "db.production.example", ["postgres:"])).toThrow();
    const machine = { hostEnrollmentId: TEST_ENROLLMENT, agentKey: "agent", acceptedEvents: 7,
      acceptedSessions: 1, acceptedTurns: 1, acceptedBodies: 1 };
    const receipt = { profile, runId: "fixture", finishedAt: "now", machines: [machine], intakePass: true };
    const durable = [{ key: TEST_ENROLLMENT, events: "7", sessions: "1", turns: "1", bodies: "1" }];
    const derived = [{ key: "agent", sessions: "1", turns: "1", tools: "1", input: "10", output: "5", unpriced: "0", cost_micros: "1" }];
    expect(compare(receipt, durable, derived).countsMatch).toBe(true);
    expect(compare(receipt, [], derived).countsMatch).toBe(false);
    expect(compare(receipt, durable, [{ ...derived[0]!, sessions: "2" }]).countsMatch).toBe(false);
    expect(compare(receipt, [...durable, ...durable], derived).countsMatch).toBe(false);
  });
  it.each([false, true])("drains the WAL and checks control success with invalidControl=%s", async (invalidControl) => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-rig-"));
    const requests: string[] = [];
    vi.stubEnv("FLEET_STAGING_ORIGIN", profile.target);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const text = String(init.body);
      if (url.endsWith("/enrollments")) {
        const answer = host();
        answer.enrollment.claims.device_key_fingerprint = deviceKeyFingerprint(JSON.parse(text).devicePublicKey);
        return new Response(JSON.stringify(answer));
      }
      if (url.endsWith("/bundle")) return new Response(JSON.stringify(invalidControl
        ? { not_modified: true, etag: "fixture", bundle: null } : bundleAnswer()));
      requests.push(text);
      if (requests.length === 1) return new Response("busy", { status: 503, headers: { "retry-after": "1" } });
      return new Response(JSON.stringify(ack(JSON.parse(text) as TachoBatch)));
    }));
    const smoke: Profile = { ...profile, machines: 1, phases: [{ seconds: 1, multiplier: 1 }], drainSeconds: 5,
      baseline: { ...profile.baseline, measured: true, sessionsPerSecond: 1 } };
    try {
      const result = await runFleet(smoke, directory, "operator-secret", signer.publicKeyPem);
      const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
      expect(result.intakePass).toBe(!invalidControl);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toBe(requests[1]);
      expect(report).toMatchObject({ acceptedSessions: 1, refusedRequests: 1, retriedRequests: 1,
        backlogEvents: 0, intakePass: !invalidControl, capacityPass: false,
        controlErrors: invalidControl ? 1 : 0,
        reconciliation: { scheduled: true, generated: true } });
      expect(report.finishedAt).not.toBeNull();
      expect(JSON.stringify(report)).not.toContain("fixture-secret");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15000);
  it("stops all network sends at the request ceiling and retains its unacknowledged WAL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-budget-"));
    vi.stubEnv("FLEET_STAGING_ORIGIN", profile.target);
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/enrollments")) {
        const answer = host();
        answer.enrollment.claims.device_key_fingerprint = deviceKeyFingerprint(JSON.parse(String(init.body)).devicePublicKey);
        return new Response(JSON.stringify(answer));
      }
      return new Response(JSON.stringify(bundleAnswer()));
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await runFleet({ ...profile, machines: 1, phases: [{ seconds: 1, multiplier: 1 }],
        baseline: { ...profile.baseline, measured: true, sessionsPerSecond: 1 },
        ceilings: { ...profile.ceilings, requests: 2 } }, directory, "secret", signer.publicKeyPem);
      const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result.intakePass).toBe(false);
      expect(report).toMatchObject({ budgetExhausted: true, networkRequests: 2, backlogSessions: 1,
        reconciliation: { scheduled: true, generated: true } });
      const wal = JSON.parse(readFileSync(join(dirname(result.reportPath), "private", "0.batch.json"), "utf8")) as TachoBatch;
      expect(wal.events).toHaveLength(7);
      expect(verifyChain(wal.events).ok).toBe(true);
      expect(report.finishedAt).not.toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 10000);
});
