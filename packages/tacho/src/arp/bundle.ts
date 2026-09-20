import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { verifyChain } from "../chain";
import { digestBytes, digestJcs, jcs, type JsonValue } from "../digest";
import { parseTachoEvent, type TachoEvent } from "../envelope";
import {
  deviceKeyFingerprint,
  type DeviceKey,
  verifyDeviceSignature,
} from "../host/device-key";
import {
  ARP_MAX_BLOB_BYTES,
  ARP_MAX_FILES,
  ARP_MAX_TOTAL_BYTES,
  arpCheckpointSchema,
  arpWorkspaceSchema,
  blobRefSchema,
  type ArpCheckpoint,
  type ArpWorkspace,
  type BlobRef,
} from "./schema";

const attestationSchema = z
  .object({
    schema: z.literal("arp.attestation/0.1"),
    subject_digest: blobRefSchema.shape.digest,
    key_id: z.string().min(1),
    algorithm: z.literal("Ed25519"),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

/** Resolve the existing root once, then reject links in every bundle component. */
function bundlePath(root: string, relative: string, create = false): string {
  const absolute = resolve(root);
  if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (
    lstatSync(absolute).isSymbolicLink() ||
    !lstatSync(absolute).isDirectory()
  ) {
    throw new Error("ARP bundle root must be a directory, not a symlink");
  }
  const base = realpathSync(absolute);
  let current = base;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const stat = lstatSync(current);
      if (
        stat.isSymbolicLink() ||
        (i < parts.length - 1 && !stat.isDirectory())
      ) {
        throw new Error("ARP bundle contains a symlink or invalid directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create && i < parts.length - 1) mkdirSync(current, { mode: 0o700 });
      else if (i < parts.length - 1) throw error;
    }
  }
  if (realpathSync(dirname(current)) !== dirname(current)) {
    throw new Error("ARP bundle directory changed during access");
  }
  return current;
}

function readBounded(
  root: string,
  relative: string,
  limit = ARP_MAX_BLOB_BYTES,
): Buffer {
  const path = bundlePath(root, relative);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error(
        "ARP file exceeds its size limit or is not a regular file",
      );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("ARP file changed during access");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0)
      throw new Error("ARP file changed during access");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function writeNew(root: string, relative: string, bytes: Uint8Array): void {
  const path = bundlePath(root, relative, true);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

function blobPath(ref: BlobRef): string {
  blobRefSchema.parse(ref);
  return `blobs/sha256/${ref.digest.slice(7)}`;
}

export function storeBlob(
  root: string,
  bytes: Uint8Array,
  mediaType: string,
): BlobRef {
  const ref = blobRefSchema.parse({
    digest: digestBytes(bytes),
    bytes: bytes.byteLength,
    media_type: mediaType,
  });
  try {
    writeNew(root, blobPath(ref), bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    readBlob(root, ref);
  }
  return ref;
}

export function readBlob(root: string, ref: BlobRef): Buffer {
  const bytes = readBounded(root, blobPath(ref), ref.bytes);
  if (bytes.length !== ref.bytes || digestBytes(bytes) !== ref.digest) {
    throw new Error(`ARP blob integrity failed: ${ref.digest}`);
  }
  return bytes;
}

function controlJson(bytes: Buffer): JsonValue {
  const value = JSON.parse(bytes.toString("utf8")) as JsonValue;
  // Canonical bytes also reject duplicate keys, invalid UTF-8, and negative zero.
  if (!Buffer.from(jcs(value)).equals(bytes))
    throw new Error("ARP control document must use canonical JSON");
  function check(item: JsonValue, depth: number): void {
    if (depth > 64) throw new Error("ARP control document exceeds depth limit");
    if (typeof item === "number" && !Number.isSafeInteger(item))
      throw new Error("ARP control numbers must be safe integers");
    if (typeof item === "string" && /[\ud800-\udfff]/u.test(item))
      throw new Error(
        "ARP control document contains an invalid Unicode string",
      );
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (/[\ud800-\udfff]/u.test(key))
          throw new Error(
            "ARP control document contains an invalid Unicode key",
          );
        check(child as JsonValue, depth + 1);
      }
    }
  }
  check(value, 0);
  return value;
}

export function writeCheckpoint(
  root: string,
  checkpoint: ArpCheckpoint,
  key: DeviceKey,
): void {
  const parsed = arpCheckpointSchema.parse(checkpoint);
  const bytes = Buffer.from(jcs(parsed));
  controlJson(bytes);
  const subjectDigest = digestBytes(bytes);
  const attestation = {
    schema: "arp.attestation/0.1",
    subject_digest: subjectDigest,
    key_id: key.fingerprint,
    algorithm: "Ed25519",
    signature: key.sign(`ARP/0.1\n${subjectDigest}`),
  };
  writeNew(root, "checkpoint.attestation.json", Buffer.from(jcs(attestation)));
  writeNew(root, "checkpoint.json", bytes);
}

/**
 * The id an approval frame is correlated by. `approval_id` is the field the
 * data model reserves for control-plane elevation; until a producer mints one,
 * every recorded approval is correlated by the tool call it gates.
 */
function approvalCorrelationId(body: {
  approval_id?: string | undefined;
  tool_use_id?: string | undefined;
}): string | undefined {
  return body.approval_id ?? body.tool_use_id;
}

/** Whether a policy decision answers an approval rather than deferring it. */
function isTerminalDecision(decision: string | undefined): boolean {
  return decision === "allow" || decision === "deny";
}

/** A capture attestation cannot waive unresolved work recorded by the source. */
export function verifySettledEvidence(events: readonly TachoEvent[]): void {
  const head = events.at(-1);
  if (head?.kind !== "turn_end")
    throw new Error("ARP source must end at a completed turn");
  let openTurn = false;
  const tools = new Set<string>();
  const requested = new Set<string>();
  const children = new Set<string>();
  const approvals = new Set<string>();
  for (const event of events) {
    if (event.kind === "turn_start") {
      if (openTurn)
        throw new Error(
          "ARP source starts a turn before closing its prior turn",
        );
      openTurn = true;
    } else if (event.kind === "turn_end") {
      if (!openTurn)
        throw new Error("ARP source ends a turn that was not recorded open");
      openTurn = false;
    }
    if (event.kind === "telemetry_gap")
      throw new Error("ARP source reports a telemetry gap");
    if (event.kind === "tool_requested") {
      const id = event.body.tool_use_id;
      if (!id || requested.has(id))
        throw new Error("ARP tool request has no unique correlation ID");
      requested.add(id);
      tools.add(id);
    } else if (event.kind === "tool_call") {
      const id = event.body.tool_use_id;
      if (!id || event.body.tool_status === undefined)
        throw new Error(
          "ARP tool result has no correlation ID or settled status",
        );
      tools.delete(id);
      // A gated call that produced a result had its approval answered.
      approvals.delete(id);
    } else if (
      event.kind === "subagent_start" ||
      event.kind === "subagent_stop"
    ) {
      // The recorder writes parent-side child identity in hook.agent_id.
      const id =
        event.subagent?.subagent_id ??
        event.attrs["hook.agent_id"] ??
        event.body.tool_use_id;
      if (!id) throw new Error("ARP child work has no correlation ID");
      if (event.kind === "subagent_start") {
        if (children.has(id))
          throw new Error("ARP child work has an ambiguous correlation ID");
        children.add(id);
      } else {
        if (!children.has(id))
          throw new Error("ARP child completion has no matching start");
        children.delete(id);
      }
    } else if (event.kind === "approval_request") {
      // The recorder correlates an approval by the tool call it gates:
      // normalizeHook builds a PermissionRequest body from toolFacts, which
      // carries tool_use_id and never approval_id. Reading approval_id alone
      // refused every recorded approval, because nothing writes that field.
      const id = approvalCorrelationId(event.body);
      if (!id || approvals.has(id))
        throw new Error("ARP approval has no unique correlation ID");
      // A request the harness already answered is settled where it stands:
      // routeHook writes policy_decision "deny" for an operator-blocked host
      // and returns that denial, so no later frame answers it. "ask" and
      // "defer" are open and must be drained by a decision or a tool result.
      if (!isTerminalDecision(event.body.policy_decision)) approvals.add(id);
    } else if (event.kind === "approval_decision") {
      const id = approvalCorrelationId(event.body);
      if (!id) throw new Error("ARP approval decision has no correlation ID");
      approvals.delete(id);
    } else if (event.kind === "policy_decision") {
      // PermissionDenied lands here carrying the gated call's tool_use_id.
      const id = approvalCorrelationId(event.body);
      if (id) approvals.delete(id);
    }
  }
  if (tools.size || children.size || approvals.size)
    throw new Error("ARP source has unsettled tools, approvals, or child work");
  const present = (value: unknown): boolean =>
    value !== undefined &&
    value !== null &&
    value !== false &&
    !(Array.isArray(value) && value.length === 0);
  if (
    (head.body.queued_turn_count ?? 0) > 0 ||
    present(head.body.background_tasks) ||
    present(head.body.session_crons)
  ) {
    throw new Error("ARP source boundary reports background or queued work");
  }
}

export function verifyBundle(
  root: string,
  trustedPublicKey: string,
): {
  checkpoint: ArpCheckpoint;
  workspace: ArpWorkspace;
  checkpointDigest: string;
} {
  const checkpointBytes = readBounded(root, "checkpoint.json");
  const checkpoint = arpCheckpointSchema.parse(controlJson(checkpointBytes));
  if (
    checkpoint.gaps.some((gap) => gap.required) ||
    checkpoint.effects.some((effect) => effect.status === "unknown")
  ) {
    throw new Error("ARP checkpoint has required gaps or unresolved effects");
  }
  const checkpointDigest = digestBytes(checkpointBytes);
  const attestation = attestationSchema.parse(
    controlJson(readBounded(root, "checkpoint.attestation.json", 4096)),
  );
  if (
    checkpoint.issuer !== deviceKeyFingerprint(trustedPublicKey) ||
    attestation.subject_digest !== checkpointDigest ||
    attestation.key_id !== deviceKeyFingerprint(trustedPublicKey) ||
    !verifyDeviceSignature(
      trustedPublicKey,
      `ARP/0.1\n${checkpointDigest}`,
      attestation.signature,
    )
  ) {
    throw new Error("ARP checkpoint signature does not match the trusted key");
  }
  let total = 0;
  const seen = new Map<string, number>();
  const read = (ref: BlobRef): Buffer => {
    if (!seen.has(ref.digest)) {
      total += ref.bytes;
      seen.set(ref.digest, ref.bytes);
      if (total > ARP_MAX_TOTAL_BYTES || seen.size > ARP_MAX_FILES + 32)
        throw new Error("ARP bundle exceeds transfer limits");
    } else if (seen.get(ref.digest) !== ref.bytes)
      throw new Error("ARP blob has inconsistent byte counts");
    return readBlob(root, ref);
  };
  for (const ref of [
    checkpoint.task,
    checkpoint.context,
    checkpoint.environment,
    checkpoint.tools,
    checkpoint.authority,
    checkpoint.capture.barrier_evidence,
  ])
    read(ref);
  for (const effect of checkpoint.effects)
    if (effect.receipt) read(effect.receipt);
  const workspace = arpWorkspaceSchema.parse(
    controlJson(read(checkpoint.workspace)),
  );
  if (workspace.exclusions.some((exclusion) => exclusion.required)) {
    throw new Error("ARP workspace excludes required state");
  }
  const paths = new Map<string, string>();
  const entries = new Map(
    workspace.entries.map((entry) => [entry.path, entry]),
  );
  let expandedBytes = 0;
  for (const entry of workspace.entries) {
    const folded = entry.path.normalize("NFC").toLowerCase();
    if (paths.has(folded))
      throw new Error(`ARP workspace path collision: ${entry.path}`);
    paths.set(folded, entry.path);
    const segments = entry.path.split("/");
    for (let n = 1; n < segments.length; n++) {
      const parent = entries.get(segments.slice(0, n).join("/"));
      if (parent?.kind !== "directory")
        throw new Error(
          `ARP workspace parent directory is missing: ${entry.path}`,
        );
    }
    if (entry.kind === "file") {
      expandedBytes += entry.blob.bytes;
      if (expandedBytes > ARP_MAX_TOTAL_BYTES)
        throw new Error("ARP expanded workspace exceeds transfer limits");
      read(entry.blob);
    }
  }
  const repositoryRoots = new Set<string>();
  for (const repository of workspace.repositories) {
    const folded = repository.root.toLowerCase();
    if (
      repositoryRoots.has(folded) ||
      (repository.root !== "." &&
        entries.get(repository.root)?.kind !== "directory")
    ) {
      throw new Error("ARP repository root is duplicated or missing");
    }
    repositoryRoots.add(folded);
  }
  const evidenceBytes = read(checkpoint.source.evidence_prefix);
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as unknown;
  if (!Buffer.from(jcs(evidence as JsonValue)).equals(evidenceBytes)) {
    throw new Error(
      "ARP evidence array must use canonical JSON without changing native events",
    );
  }
  if (!Array.isArray(evidence) || evidence.length > 100_000)
    throw new Error("ARP source evidence must be a bounded Tacho event array");
  const events = evidence.map((raw: unknown) => {
    const event = parseTachoEvent(raw);
    if (
      digestJcs(raw as JsonValue) !== digestJcs(event as unknown as JsonValue)
    ) {
      throw new Error(
        "ARP source evidence cannot change during schema validation",
      );
    }
    return event;
  });
  const chain = verifyChain(events);
  if (!chain.ok)
    throw new Error(
      `ARP source evidence failed verification: ${chain.violations.join(", ")}`,
    );
  verifySettledEvidence(events);
  const head = events[events.length - 1]!;
  const boundary = checkpoint.source.boundary;
  if (
    head.kind !== "turn_end" ||
    head.hash !== boundary.digest ||
    String(head.seq) !== boundary.seq ||
    head.session_uuid !== boundary.stream_id
  ) {
    throw new Error("ARP source boundary must match the final completed turn");
  }
  return { checkpoint, workspace, checkpointDigest };
}
