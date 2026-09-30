import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { generateDeviceKey, deviceKeyPem } from "../../../packages/tacho/src/host/device-key";
import { TACHO_BUNDLE_FEATURES, TACHO_MAX_REQUEST_BYTES, type TachoBatch } from "../../../packages/tacho/src/wire";
import { persistentOutputRoot } from "./storage";
import { ArrivalClock, Latency, eventsInRange, makeBatch, reconcile, sampleAt, validateControlBundle, validateEnrollment, validateProfile, type Profile, type WorkloadHost } from "./core";

export class HttpFailure extends Error {
  constructor(readonly status: number, readonly retryMs: number) { super(`Staging request returned HTTP ${status}.`); }
}

/** No redirects. The deadline covers headers and the bounded response body. */
export async function postJson(url: string, key: string, body: string, timeoutMs = 60000): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { method: "POST", redirect: "error", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const seconds = Number(response.headers.get("retry-after"));
    throw new HttpFailure(response.status, Number.isFinite(seconds) ? Math.min(60000, Math.max(1000, seconds * 1000)) : 1000);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Staging response has no body.");
  const buffer = Buffer.alloc(2 * 1024 * 1024);
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > buffer.length) throw new Error("Staging response exceeds 2 MiB.");
      buffer.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function persist(path: string, value: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function readSmall(path: string, maxBytes: number): string {
  if (statSync(path).size > maxBytes) throw new Error("Input file exceeds its size limit.");
  return readFileSync(path, "utf8");
}

interface Pending { bytes: number; events: number; turns: number; bodies: number; created: number; attempts: number; next: number; blocked: boolean }
interface Machine {
  host: WorkloadHost & { apiKey: string }; path: string; pending?: Pending; busy: boolean;
  generatedEvents: number; acceptedEvents: number; generatedSessions: number; acceptedSessions: number;
  acceptedTurns: number; acceptedBodies: number;
  controlResponses: number;
}

export async function runFleet(profile: Profile, output: string, token: string, pinnedKey: string) {
  validateProfile(profile, process.env["FLEET_STAGING_ORIGIN"] ?? "", true);
  const runId = randomUUID();
  const workflowRun = process.env["GITHUB_RUN_ID"];
  if (workflowRun !== undefined && !/^[0-9]+$/.test(workflowRun)) throw new Error("Invalid workflow run identifier.");
  const directory = resolve(output, workflowRun ? `${workflowRun}-${runId}` : runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stateDir = join(directory, "private");
  mkdirSync(stateDir, { mode: 0o700 });
  const reportPath = join(directory, "report.json");
  const machines: Machine[] = [];
  const counts = { scheduledSessions: 0, generatedSessions: 0, generatedEvents: 0, generatedBytes: 0,
    acceptedSessions: 0, acceptedEvents: 0, refusedRequests: 0, retriedRequests: 0,
    transportErrors: 0, reconciliationErrors: 0, missedSessions: 0, missedEvents: 0,
    controlErrors: 0, controlRequests: 0, replayedBatches: 0 };
  const statuses: Record<string, number> = {};
  const ack = new Latency();
  const endToEnd = new Latency();
  const control = new Latency();
  let queueBytes = 0;
  let active = 0;
  let controlActive = false;
  let stopping = false;
  let budgetExhausted = false;
  let networkRequests = 0;
  let networkBytesReserved = 0;
  const request: typeof postJson = async (url, key, body, timeoutMs) => {
    const reserved = Buffer.byteLength(body) + 2 * 1024 * 1024 + 16384;
    if (networkRequests >= profile.ceilings.requests || networkBytesReserved + reserved > profile.ceilings.networkBytes) {
      budgetExhausted = true; stopping = true;
      throw new Error("The fleet exhausted its request or network-byte ceiling.");
    }
    networkRequests++; networkBytesReserved += reserved;
    return postJson(url, key, body, timeoutMs);
  };
  let phaseIndex = -1;
  let peakRss = 0;
  const samples: object[] = [];
  const startedAt = new Date().toISOString();
  let arrivalsStoppedAt: string | null = null;
  let drainMs: number | null = null;
  let finalized = false;
  const generatedSamples: Record<string, number> = {};
  const snapshot = (final = false) => {
    const now = Date.now();
    const pending = machines.flatMap((machine) => machine.pending ? [machine.pending] : []);
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    const current = { at: new Date(now).toISOString(), phaseIndex, ...counts, queueBytes,
      backlogSessions: pending.length, backlogEvents: pending.reduce((sum, item) => sum + item.events, 0),
      oldestBacklogMs: pending.length ? Math.max(...pending.map((item) => now - item.created)) : 0,
      generatorMemory: memory, active };
    if (samples.length === 1600) samples.shift();
    samples.push(current);
    const ackReport = ack.report();
    const controlReport = control.report();
    const intakePass = final && machines.length === profile.machines && !stopping &&
      machines.every((machine) => machine.acceptedSessions > 0 && machine.controlResponses > 0) &&
      counts.generatedSessions > 0 && counts.missedSessions === 0 && pending.length === 0 &&
      counts.reconciliationErrors === 0 && counts.controlErrors === 0 &&
      counts.acceptedEvents === counts.generatedEvents &&
      ackReport.p99UpperMs !== null && ackReport.p99UpperMs <= profile.ackP99Ms &&
      controlReport.p99UpperMs !== null && controlReport.p99UpperMs <= profile.controlP99Ms;
    persist(reportPath, JSON.stringify({ schema: "fleet-capacity-report/v1", runId, startedAt, arrivalsStoppedAt,
      finishedAt: final ? new Date().toISOString() : null, sha: process.env["GITHUB_SHA"] ?? null,
      profile, intakePass, capacityPass: false, drainMs, peakGeneratorRss: peakRss,
      ...current, statuses, generatedSamples, networkRequests, networkBytesReserved, budgetExhausted,
      ingestionLatency: ackReport, arrivalToAckLatency: endToEnd.report(),
      controlLatency: controlReport,
      reconciliation: { scheduled: counts.generatedSessions + counts.missedSessions === counts.scheduledSessions,
        generated: counts.acceptedEvents + current.backlogEvents === counts.generatedEvents },
      machines: machines.map((machine) => ({ hostEnrollmentId: machine.host.hostEnrollmentId,
        agentKey: machine.host.agentKey, generatedEvents: machine.generatedEvents,
        acceptedEvents: machine.acceptedEvents, generatedSessions: machine.generatedSessions,
        acceptedSessions: machine.acceptedSessions, acceptedTurns: machine.acceptedTurns,
        acceptedBodies: machine.acceptedBodies, controlResponses: machine.controlResponses })), samples,
      unverified: ["Run reconcile.ts against staging stores after workers drain.",
        "Provider admission, monetary idempotence, tenant isolation, fault injection, and service memory require separate observations.",
        "This generator sends complete sessions with 1 to 30 turns in one batch; longer histories require a separate workload."] }, null, 2));
    return intakePass;
  };
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const outstanding = new Set<Promise<void>>();
  const ship = (machine: Machine) => {
    const pending = machine.pending!;
    machine.busy = true;
    active++;
    if (pending.attempts++) counts.retriedRequests++;
    const task = (async () => {
      const begin = performance.now();
      try {
        const text = readSmall(machine.path, TACHO_MAX_REQUEST_BYTES);
        const batch = JSON.parse(text) as TachoBatch;
        const response = await request(machine.host.enrollment.claims.ingest_endpoint, machine.host.apiKey, text);
        try { reconcile(batch, response); } catch (error) {
          counts.reconciliationErrors++; pending.blocked = true; throw error;
        }
        ack.add(performance.now() - begin);
        // Replay every hundredth batch before releasing its WAL slot.
        if ((counts.acceptedSessions + 1) % 100 === 0) {
          const repeated = await request(machine.host.enrollment.claims.ingest_endpoint, machine.host.apiKey, text);
          try { reconcile(batch, repeated); } catch (error) {
            counts.reconciliationErrors++; pending.blocked = true; throw error;
          }
          counts.replayedBatches++;
        }
        unlinkSync(machine.path);
        queueBytes -= pending.bytes;
        machine.pending = undefined;
        machine.acceptedEvents += pending.events;
        machine.acceptedSessions++;
        machine.acceptedTurns += pending.turns;
        machine.acceptedBodies += pending.bodies;
        counts.acceptedEvents += pending.events;
        counts.acceptedSessions++;
        endToEnd.add(Date.now() - pending.created);
      } catch (error) {
        if (error instanceof HttpFailure) {
          counts.refusedRequests++;
          statuses[String(error.status)] = (statuses[String(error.status)] ?? 0) + 1;
          pending.blocked ||= error.status < 500 && error.status !== 429 && error.status !== 408;
          pending.next = Date.now() + error.retryMs;
        } else {
          counts.transportErrors++;
          pending.next = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(5, pending.attempts));
        }
      } finally { machine.busy = false; active--; }
    })();
    outstanding.add(task);
    void task.finally(() => outstanding.delete(task));
  };
  let scan = 0;
  const pump = () => {
    if (budgetExhausted) return;
    for (let n = 0; n < machines.length && active < profile.concurrency; n++) {
      const machine = machines[scan++ % machines.length]!;
      if (machine.pending && !machine.busy && !machine.pending.blocked && machine.pending.next <= Date.now()) ship(machine);
    }
  };
  let probe = 0;
  let nextProbe = 0;
  const probeControl = () => {
    if (budgetExhausted || controlActive || Date.now() < nextProbe || !machines.length) return;
    nextProbe = Date.now() + 15000;
    controlActive = true;
    const machine = machines[probe++ % machines.length]!;
    const task = (async () => {
      const begin = performance.now();
      counts.controlRequests++;
      try {
        validateControlBundle(await request(machine.host.enrollment.claims.bundle_endpoint, machine.host.apiKey,
          JSON.stringify({ host_enrollment_id: machine.host.hostEnrollmentId }), 15000),
          machine.host.hostEnrollmentId, pinnedKey);
        machine.controlResponses++;
        control.add(performance.now() - begin);
      } catch { counts.controlErrors++; } finally { controlActive = false; }
    })();
    outstanding.add(task);
    void task.finally(() => outstanding.delete(task));
  };
  try {
    const enrollmentDeadline = Date.now() + 10 * 60 * 1000;
    for (let index = 0; index < profile.machines; index++) {
      if (stopping || Date.now() >= enrollmentDeadline) throw new Error("Fleet enrollment stopped or exceeded ten minutes.");
      const key = generateDeviceKey();
      const hostname = `fc${runId.slice(0, 8)}${index.toString().padStart(3, "0")}`;
      const raw = await request(`${profile.target}/v1/${profile.orgSlug}/${profile.workspaceSlug}/tacho/enrollments`, token,
        JSON.stringify({ hostname, osUser: "fleet-capacity", platform: "linux", arch: "x64",
          devicePublicKey: key.publicKey, harnesses: ["claude-code"], bundleFeatures: [...TACHO_BUNDLE_FEATURES],
          managed: false, validityDays: 2 }));
      const host = validateEnrollment(raw, profile, key.fingerprint, pinnedKey);
      if (machines.some((machine) => machine.host.hostEnrollmentId === host.hostEnrollmentId || machine.host.agentKey === host.agentKey))
        throw new Error("The fleet received a duplicate host or agent identity.");
      persist(join(stateDir, `${index}.identity.json`), JSON.stringify({ host, devicePrivateKeyPem: deviceKeyPem(key) }));
      const claims = host.enrollment.claims;
      const compact = { hostEnrollmentId: host.hostEnrollmentId, agentKey: host.agentKey, apiKey: host.apiKey,
        enrollment: { claims: { workspace_id: claims.workspace_id,
          ingest_endpoint: claims.ingest_endpoint, bundle_endpoint: claims.bundle_endpoint } } };
      machines.push({ host: compact, path: join(stateDir, `${index}.batch.json`), busy: false,
        generatedEvents: 0, acceptedEvents: 0, generatedSessions: 0, acceptedSessions: 0, acceptedTurns: 0, acceptedBodies: 0,
        controlResponses: 0 });
    }
    let ordinal = 0;
    let nextSnapshot = 0;
    for (const [index, phase] of profile.phases.entries()) {
      phaseIndex = index;
      const start = performance.now();
      const clock = new ArrivalClock(profile.baseline.sessionsPerSecond * phase.multiplier, start, phase.seconds * 1000);
      while (!stopping) {
        const now = performance.now();
        const { count } = clock.due(now);
        counts.scheduledSessions += count;
        // Account for every arrival. At most one session per host is materialized per tick.
        const materialized = Math.min(count, machines.length);
        for (let n = 0; n < materialized; n++, ordinal++) {
          const sample = sampleAt(profile, ordinal);
          const machine = machines[ordinal % machines.length]!;
          if (machine.pending || queueBytes + TACHO_MAX_REQUEST_BYTES > profile.maxQueueBytes) {
            counts.missedSessions++;
            counts.missedEvents += 2 + sample.turns * 5;
            continue;
          }
          const batch = makeBatch(machine.host, sample.turns, sample.bodyBytes, Date.now());
          const text = JSON.stringify(batch);
          const bytes = Buffer.byteLength(text);
          if (bytes > TACHO_MAX_REQUEST_BYTES) throw new Error("The synthetic batch exceeds the Tacho request limit.");
          persist(machine.path, text);
          machine.pending = { bytes, events: batch.events.length, turns: sample.turns, bodies: batch.bodies?.length ?? 0,
            created: Date.now(), attempts: 0, next: 0, blocked: false };
          queueBytes += bytes;
          counts.generatedSessions++; counts.generatedEvents += batch.events.length; counts.generatedBytes += bytes;
          const sampleKey = `${sample.turns}:${sample.bodyBytes}`;
          generatedSamples[sampleKey] = (generatedSamples[sampleKey] ?? 0) + 1;
          machine.generatedSessions++; machine.generatedEvents += batch.events.length;
        }
        const missed = count - materialized;
        counts.missedSessions += missed;
        counts.missedEvents += eventsInRange(profile, ordinal, missed);
        ordinal += missed;
        pump(); probeControl();
        if (Date.now() >= nextSnapshot) { snapshot(); nextSnapshot = Date.now() + 60000; }
        if (now >= start + phase.seconds * 1000) break;
        await sleep(10);
      }
      if (stopping) break;
    }
    arrivalsStoppedAt = new Date().toISOString();
    const drainStart = Date.now();
    while (!budgetExhausted && machines.some((machine) => machine.pending) && Date.now() - drainStart < profile.drainSeconds * 1000) {
      pump(); probeControl();
      await sleep(100);
    }
    await Promise.all(outstanding);
    drainMs = Date.now() - drainStart;
    const intakePass = snapshot(true);
    finalized = true;
    return { reportPath, intakePass };
  } finally {
    await Promise.all(outstanding);
    if (!finalized) snapshot();
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}

export async function main(args: string[]): Promise<void> {
  const [mode, profilePath, extra] = args;
  if (!profilePath || extra !== undefined || (mode !== "plan" && mode !== "run")) throw new Error("Usage: run.ts plan|run profile.json");
  const profile = validateProfile(JSON.parse(readSmall(profilePath, 128 * 1024)) as Profile,
    process.env["FLEET_STAGING_ORIGIN"] ?? "", mode === "run");
  if (mode === "plan") {
    process.stdout.write(`${JSON.stringify({ profile, requestsPerSecond: profile.phases.map((phase) =>
      profile.baseline.sessionsPerSecond * phase.multiplier), maxPendingSessions: profile.machines,
      maxWalBytes: profile.maxQueueBytes, maxInflightPayloadBytes: profile.concurrency * TACHO_MAX_REQUEST_BYTES,
      networkRequestsSent: 0 }, null, 2)}\n`);
    return;
  }
  const output = persistentOutputRoot(process.env["FLEET_OUTPUT_ROOT"] ?? "");
  const token = process.env["FLEET_OPERATOR_TOKEN"];
  const pinnedKey = process.env["FLEET_BUNDLE_PUBLIC_KEY_PEM"];
  if (!token || !pinnedKey) throw new Error("Staging operator credentials and the pinned bundle public key are required.");
  const result = await runFleet(profile, output, token, pinnedKey);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.intakePass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("Fleet run failed. Inspect the numeric report and retain the private WAL on the runner.\n");
    process.exitCode = 1;
  });
}
