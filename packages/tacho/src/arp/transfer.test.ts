import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { digestBytes, jcs, type JsonValue } from "../digest";
import { addArpCommands } from "../cli/arp";
import { generateDeviceKey, deviceKeyPem } from "../host/device-key";
import { minimalSession, sealAll, unsealed } from "../test-helpers";
import { readBlob, storeBlob, verifyBundle, writeCheckpoint } from "./bundle";
import type { ArpCheckpoint, ArpWorkspace } from "./schema";
import { captureCheckpoint, prepareCheckpoint } from "./transfer";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "arp-transfer-"));
  roots.push(root);
  const workspace = join(root, "source");
  mkdirSync(join(workspace, "bin"), { recursive: true });
  writeFileSync(join(workspace, "main.ts"), "export const answer = 42;\n");
  const binary = Buffer.from([0, 255, 128, 10, 1, 2, 3]);
  writeFileSync(join(workspace, "bin", "untracked"), binary);
  chmodSync(join(workspace, "bin", "untracked"), 0o755);
  const key = generateDeviceKey();
  const keyFile = join(root, "device.pem");
  writeFileSync(keyFile, deviceKeyPem(key), { mode: 0o600 });
  const events = minimalSession().slice(0, -1);
  const evidenceFile = join(root, "evidence.ndjson");
  writeFileSync(
    evidenceFile,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  const briefFile = join(root, "brief.json");
  const brief = {
    schema: "arp.capture-brief/0.1",
    task: "Add a second export without changing answer.",
    context:
      "The answer export is complete. Continue with the remaining export.",
    files: ["main.ts", "bin/untracked"],
    exclusions: [],
    export_authorized: true,
    boundary_digest: events[events.length - 1]?.hash,
  };
  writeFileSync(briefFile, JSON.stringify(brief));
  const out = join(root, "bundle");
  return {
    root,
    workspace,
    key,
    binary,
    brief,
    events,
    options: {
      workspace,
      evidenceFile,
      briefFile,
      out,
      keyFile,
      attestBoundary: true,
    },
    saveBrief: () => writeFileSync(briefFile, JSON.stringify(brief)),
  };
}

function resign(
  f: ReturnType<typeof fixture>,
  change: (checkpoint: ArpCheckpoint) => void,
) {
  const { checkpoint } = verifyBundle(f.options.out, f.key.publicKey);
  change(checkpoint);
  rmSync(join(f.options.out, "checkpoint.json"));
  rmSync(join(f.options.out, "checkpoint.attestation.json"));
  writeCheckpoint(f.options.out, checkpoint, f.key);
}

function reviseContext(
  f: ReturnType<typeof fixture>,
  change: (frame: Record<string, unknown>) => void,
) {
  resign(f, (checkpoint) => {
    const frames = JSON.parse(
      readBlob(f.options.out, checkpoint.context).toString("utf8"),
    ) as Record<string, unknown>[];
    const frame = frames[0];
    if (!frame) throw new Error("Fixture has no context frame");
    change(frame);
    checkpoint.context = storeBlob(
      f.options.out,
      Buffer.from(jcs(frames as unknown as JsonValue)),
      "application/json",
    );
  });
}

describe("ARP capture and preparation", () => {
  it("carries a CGP episode with source provenance and UTF-8 token cost", () => {
    const f = fixture();
    f.brief.context = "Résumé: preserve the café export. 🧪";
    f.saveBrief();
    const captured = captureCheckpoint(f.options);
    const { checkpoint } = verifyBundle(f.options.out, captured.publicKey);
    const frames = JSON.parse(
      readBlob(f.options.out, checkpoint.context).toString("utf8"),
    ) as unknown[];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: "episode",
      content: f.brief.context,
      content_digest: digestBytes(f.brief.context),
      token_cost: Math.ceil(Buffer.byteLength(f.brief.context, "utf8") / 4),
      citation_label: `Source run, frame ${checkpoint.source.boundary.seq}`,
      provenance: [
        {
          type: "derivation",
          digest: f.brief.boundary_digest,
          method: "operator-handoff-summary",
          by: f.key.fingerprint,
          uri: `urn:arp:source:${encodeURIComponent(checkpoint.source.boundary.stream_id)}:${checkpoint.source.boundary.seq}`,
        },
      ],
    });
    const prepared = prepareCheckpoint({
      bundle: f.options.out,
      destination: join(f.root, "destination"),
      publicKey: captured.publicKey,
      harness: "claude-code",
    });
    expect(JSON.parse(readFileSync(prepared.promptFile, "utf8"))).toMatchObject(
      { context_frames: frames },
    );
    const report = JSON.parse(readFileSync(prepared.reportPath, "utf8")) as {
      trace_format: string;
      trace_checks: { status: string }[];
    };
    expect(report.trace_format).toBe("contextgraph-trace/0.1-sketch");
    expect(report.trace_checks.length).toBeGreaterThan(0);
    expect(report.trace_checks.every((check) => check.status !== "fail")).toBe(
      true,
    );
  });

  it.each(["content_digest", "token_cost"])(
    "refuses signed CGP frames with an invalid %s",
    (field) => {
      const f = fixture();
      captureCheckpoint(f.options);
      reviseContext(f, (frame) => {
        frame[field] =
          field === "content_digest" ? `sha256:${"0".repeat(64)}` : 0;
      });
      const destination = join(f.root, "destination");
      expect(() =>
        prepareCheckpoint({
          bundle: f.options.out,
          destination,
          publicKey: f.key.publicKey,
          harness: "codex",
        }),
      ).toThrow(/CGP|digest|token cost/i);
      expect(existsSync(destination)).toBe(false);
    },
  );

  it.each(["compact", "reference"])(
    "refuses CGP %s frames without a resolver",
    (representation) => {
      const f = fixture();
      captureCheckpoint(f.options);
      reviseContext(f, (frame) => {
        frame.representation = representation;
        frame.content_ref = { provider_id: "acme", uri: "urn:acme:source:1" };
        if (representation === "reference") {
          delete frame.content;
          delete frame.content_digest;
          frame.token_cost = 0;
        } else {
          frame.transform = {
            method: "summary",
            implementation: "acme",
            version: "1",
          };
        }
      });
      const destination = join(f.root, "destination");
      expect(() =>
        prepareCheckpoint({
          bundle: f.options.out,
          destination,
          publicKey: f.key.publicKey,
          harness: "codex",
        }),
      ).toThrow(/representation|full/i);
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("preserves an unknown full CGP kind as untrusted context", () => {
    const f = fixture();
    captureCheckpoint(f.options);
    reviseContext(f, (frame) => {
      frame.kind = "acme:handoff-observation";
      frame.representation = "full";
      frame["acme:annotation"] = { reviewed: false };
    });
    const prepared = prepareCheckpoint({
      bundle: f.options.out,
      destination: join(f.root, "destination"),
      publicKey: f.key.publicKey,
      harness: "codex",
    });
    const prompt = JSON.parse(readFileSync(prepared.promptFile, "utf8"));
    expect(prompt.context_frames[0]).toMatchObject({
      kind: "acme:handoff-observation",
      representation: "full",
      content: f.brief.context,
      "acme:annotation": { reviewed: false },
    });
    expect(prompt.context_trust).toMatch(/historical.*data/i);
    expect(prepared.command.args.join(" ")).toContain(
      "untrusted historical data",
    );
  });

  it("blocks a validly hashed source whose repeated effect fails CGP replay", () => {
    const f = fixture();
    const turn = { turn: { turn_seq: 1, prompt_id: "p1" } };
    const events = sealAll([
      unsealed("agent_start", {
        model: "test",
        session_start_source: "startup",
      }),
      unsealed("turn_start", { prompt_length: 10 }, turn),
      unsealed("file_io", { effect_id: "write-1" }, turn),
      unsealed("file_io", { effect_id: "write-1" }, turn),
      unsealed(
        "turn_end",
        { last_assistant_message_digest: `sha256:${"a".repeat(64)}` },
        turn,
      ),
    ]);
    writeFileSync(f.options.evidenceFile, JSON.stringify(events));
    f.brief.boundary_digest = events.at(-1)?.hash;
    f.saveBrief();
    const captured = captureCheckpoint(f.options);
    const destination = join(f.root, "destination");
    expect(() =>
      prepareCheckpoint({
        bundle: f.options.out,
        destination,
        publicKey: captured.publicKey,
        harness: "codex",
      }),
    ).toThrow(/CGP trace replay/i);
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses a signed CGP frame whose validity window expired", () => {
    const f = fixture();
    captureCheckpoint(f.options);
    reviseContext(f, (frame) => {
      frame.valid_from = "2000-01-01T00:00:00.000Z";
      frame.valid_to = "2000-01-02T00:00:00.000Z";
    });
    const destination = join(f.root, "destination");
    expect(() =>
      prepareCheckpoint({
        bundle: f.options.out,
        destination,
        publicKey: f.key.publicKey,
        harness: "codex",
      }),
    ).toThrow(/validity window/i);
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses a duplicate native turn start before trace projection can repair it", () => {
    const f = fixture();
    const turn = { turn: { turn_seq: 1, prompt_id: "p1" } };
    const events = sealAll([
      unsealed("agent_start", {
        model: "test",
        session_start_source: "startup",
      }),
      unsealed("turn_start", { prompt_length: 10 }, turn),
      unsealed("turn_start", { prompt_length: 10 }, turn),
      unsealed(
        "turn_end",
        { last_assistant_message_digest: `sha256:${"a".repeat(64)}` },
        turn,
      ),
    ]);
    writeFileSync(f.options.evidenceFile, JSON.stringify(events));
    f.brief.boundary_digest = events.at(-1)?.hash;
    f.saveBrief();
    expect(() => captureCheckpoint(f.options)).toThrow(/turn|lifecycle/i);
    expect(existsSync(f.options.out)).toBe(false);
  });

  it.each(["claude-code", "codex", "cursor", "stella"] as const)(
    "restores exact bytes into a separate workspace for %s",
    async (harness) => {
      const f = fixture();
      const captured = await captureCheckpoint(f.options);
      const sourceBefore = readFileSync(join(f.workspace, "main.ts"));
      const prepared = await prepareCheckpoint({
        bundle: f.options.out,
        destination: join(f.root, "destination"),
        publicKey: captured.publicKey,
        harness,
      });
      expect(prepared.checkpointDigest).toBe(captured.checkpointDigest);
      expect(prepared.workspace).not.toBe(f.workspace);
      expect(readFileSync(join(prepared.workspace, "main.ts"))).toEqual(
        sourceBefore,
      );
      expect(readFileSync(join(prepared.workspace, "bin/untracked"))).toEqual(
        f.binary,
      );
      expect(
        statSync(join(prepared.workspace, "bin/untracked")).mode & 0o111,
      ).not.toBe(0);
      expect(readFileSync(prepared.promptFile, "utf8")).toContain(f.brief.task);
      expect(readFileSync(prepared.promptFile, "utf8")).toContain(
        f.brief.context,
      );
      expect(existsSync(prepared.reportPath)).toBe(true);
      expect(
        JSON.parse(readFileSync(prepared.reportPath, "utf8")),
      ).toMatchObject({
        status: "degraded",
        launch_authorized: false,
        native_history_imported: false,
      });
      expect(JSON.stringify(prepared.command)).not.toMatch(
        /dangerously|skip-permission|bypass|yolo/,
      );
      writeFileSync(join(prepared.workspace, "main.ts"), "candidate changes\n");
      expect(readFileSync(join(f.workspace, "main.ts"))).toEqual(sourceBefore);
    },
  );

  it("refuses a signer other than the independently trusted device", async () => {
    const f = fixture();
    await captureCheckpoint(f.options);
    const destination = join(f.root, "destination");
    expect(() =>
      prepareCheckpoint({
        bundle: f.options.out,
        destination,
        publicKey: generateDeviceKey().publicKey,
        harness: "codex",
      }),
    ).toThrow(/sign|trust|key/i);
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses an existing destination without overwriting its files", async () => {
    const f = fixture();
    const captured = await captureCheckpoint(f.options);
    const destination = join(f.root, "destination");
    mkdirSync(destination);
    writeFileSync(join(destination, "keep.txt"), "existing work");
    expect(() =>
      prepareCheckpoint({
        bundle: f.options.out,
        destination,
        publicKey: captured.publicKey,
        harness: "claude-code",
      }),
    ).toThrow(/exist/i);
    expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe(
      "existing work",
    );
  });

  it("refuses corrupted file blobs before creating the destination", async () => {
    const f = fixture();
    const captured = await captureCheckpoint(f.options);
    const digest = digestBytes(f.binary);
    writeFileSync(
      join(f.options.out, "blobs", "sha256", digest.slice(7)),
      Buffer.alloc(f.binary.length),
    );
    const destination = join(f.root, "destination");
    expect(() =>
      prepareCheckpoint({
        bundle: f.options.out,
        destination,
        publicKey: captured.publicKey,
        harness: "codex",
      }),
    ).toThrow(/integrity|digest|hash/i);
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(f.workspace, "bin/untracked"))).toEqual(f.binary);
  });

  it.each(["required gap", "unknown effect", "required exclusion"])(
    "refuses a correctly signed checkpoint with a %s",
    async (condition) => {
      const f = fixture();
      await captureCheckpoint(f.options);
      resign(f, (checkpoint) => {
        if (condition === "required gap") {
          checkpoint.gaps.push({
            code: "tool_unmapped",
            dimension: "tools",
            required: true,
            detail: "A required tool is unavailable.",
          });
        } else if (condition === "unknown effect") {
          checkpoint.effects.push({
            operation_id: "external-send",
            status: "unknown",
            external_ids: [],
          });
        } else {
          const workspace = JSON.parse(
            readBlob(f.options.out, checkpoint.workspace).toString("utf8"),
          ) as ArpWorkspace;
          workspace.exclusions.push({
            path: "required.db",
            required: true,
            reason: "Required state is unavailable.",
          });
          checkpoint.workspace = storeBlob(
            f.options.out,
            Buffer.from(jcs(workspace as unknown as JsonValue)),
            "application/json",
          );
        }
      });
      const destination = join(f.root, "destination");
      expect(() =>
        prepareCheckpoint({
          bundle: f.options.out,
          destination,
          publicKey: f.key.publicKey,
          harness: "codex",
        }),
      ).toThrow(/required|unknown|effect|gap|exclusion/i);
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("refuses a recognized credential in a signed imported task", async () => {
    const f = fixture();
    await captureCheckpoint(f.options);
    resign(f, (checkpoint) => {
      checkpoint.task = storeBlob(
        f.options.out,
        Buffer.from(jcs({ request: deviceKeyPem(generateDeviceKey()) })),
        "application/json",
      );
    });
    const destination = join(f.root, "destination");
    expect(() =>
      prepareCheckpoint({
        bundle: f.options.out,
        destination,
        publicKey: f.key.publicKey,
        harness: "codex",
      }),
    ).toThrow(/credential|secret/i);
    expect(existsSync(destination)).toBe(false);
  });

  it.each(["../escape.txt", "MAIN.ts", ".claude/settings.json"])(
    "refuses signed workspace entry %s before restoring files",
    async (path) => {
      const f = fixture();
      await captureCheckpoint(f.options);
      resign(f, (checkpoint) => {
        const workspace = JSON.parse(
          readBlob(f.options.out, checkpoint.workspace).toString("utf8"),
        ) as ArpWorkspace;
        const original = workspace.entries.find(
          (entry) => entry.kind === "file",
        );
        if (!original || original.kind !== "file")
          throw new Error("Fixture has no file entry");
        if (path.startsWith(".claude/"))
          workspace.entries.push({ kind: "directory", path: ".claude" });
        workspace.entries.push({ ...original, path });
        checkpoint.workspace = storeBlob(
          f.options.out,
          Buffer.from(jcs(workspace as unknown as JsonValue)),
          "application/json",
        );
      });
      const destination = join(f.root, "destination");
      expect(() =>
        prepareCheckpoint({
          bundle: f.options.out,
          destination,
          publicKey: f.key.publicKey,
          harness: "codex",
        }),
      ).toThrow(/path|collision|configuration/i);
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(join(f.root, "escape.txt"))).toBe(false);
    },
  );

  it("wires capture, verify, and preparation through the CLI", async () => {
    const f = fixture();
    const output: string[] = [];
    const errors: string[] = [];
    const invoke = async (args: string[]) => {
      const program = new Command().exitOverride();
      addArpCommands(program, {
        out: (message) => output.push(message),
        err: (message) => errors.push(message),
      });
      await program.parseAsync(["arp", ...args], { from: "user" });
    };
    await invoke([
      "capture",
      "--workspace",
      f.workspace,
      "--evidence",
      f.options.evidenceFile,
      "--brief",
      f.options.briefFile,
      "--out",
      f.options.out,
      "--key",
      f.options.keyFile,
      "--attest-boundary",
    ]);
    expect(errors).toEqual([]);
    const captured = JSON.parse(output[0] ?? "null") as {
      checkpointDigest: string;
      publicKey: string;
    };
    await invoke([
      "verify",
      "--bundle",
      f.options.out,
      "--public-key",
      captured.publicKey,
    ]);
    expect(JSON.parse(output[1] ?? "null")).toEqual({
      checkpointDigest: captured.checkpointDigest,
    });
    await invoke([
      "prepare",
      "--bundle",
      f.options.out,
      "--public-key",
      captured.publicKey,
      "--destination",
      join(f.root, "cli-destination"),
      "--harness",
      "claude-code",
    ]);
    expect(errors).toEqual([]);
    const prepared = JSON.parse(output[2] ?? "null") as {
      workspace: string;
      checkpointDigest: string;
    };
    expect(prepared.checkpointDigest).toBe(captured.checkpointDigest);
    expect(readFileSync(join(prepared.workspace, "bin/untracked"))).toEqual(
      f.binary,
    );
  });

  it("requires an explicit current-boundary attestation", async () => {
    const f = fixture();
    expect(() =>
      captureCheckpoint({ ...f.options, attestBoundary: false }),
    ).toThrow(/attest|boundary/i);
    expect(existsSync(f.options.out)).toBe(false);
  });

  it("refuses an unauthorized export", async () => {
    const f = fixture();
    f.brief.export_authorized = false;
    f.saveBrief();
    expect(() => captureCheckpoint(f.options)).toThrow(/authoriz|export/i);
    expect(existsSync(f.options.out)).toBe(false);
  });

  it("refuses a historical digest paired with the current workspace", async () => {
    const f = fixture();
    f.brief.boundary_digest = f.events[0]?.hash;
    f.saveBrief();
    expect(() => captureCheckpoint(f.options)).toThrow(/boundary|tail|digest/i);
    expect(existsSync(f.options.out)).toBe(false);
  });

  it("refuses evidence content changed after its hash was sealed", async () => {
    const f = fixture();
    const evidence = readFileSync(f.options.evidenceFile, "utf8");
    writeFileSync(
      f.options.evidenceFile,
      evidence.replace('"prompt_length":12', '"prompt_length":13'),
    );
    expect(() => captureCheckpoint(f.options)).toThrow(/chain|hash|integrity/i);
    expect(existsSync(f.options.out)).toBe(false);
  });

  it("refuses evidence that ends in an unfinished turn", async () => {
    const f = fixture();
    const events = f.events.slice(0, -1);
    writeFileSync(f.options.evidenceFile, JSON.stringify(events));
    f.brief.boundary_digest = events[events.length - 1]?.hash;
    f.saveBrief();
    expect(() => captureCheckpoint(f.options)).toThrow(/turn|boundary/i);
    expect(existsSync(f.options.out)).toBe(false);
  });

  it("refuses a turn with a known unresolved tool request", async () => {
    const f = fixture();
    const events = sealAll([
      unsealed("agent_start", {
        model: "test",
        session_start_source: "startup",
      }),
      unsealed("turn_start", { prompt_length: 10 }),
      unsealed("tool_requested", {
        tool_name: "Bash",
        tool_use_id: "pending",
        policy_decision: "allow",
      }),
      unsealed("turn_end", {
        last_assistant_message_digest: `sha256:${"a".repeat(64)}`,
      }),
    ]);
    writeFileSync(
      f.options.evidenceFile,
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    f.brief.boundary_digest = events[events.length - 1]?.hash;
    f.saveBrief();
    expect(() => captureCheckpoint(f.options)).toThrow(
      /pending|unresolved|settled|tool/i,
    );
    expect(existsSync(f.options.out)).toBe(false);
  });

  it("refuses a turn with an active subagent", async () => {
    const f = fixture();
    const events = sealAll([
      unsealed("agent_start", {
        model: "test",
        session_start_source: "startup",
      }),
      unsealed("turn_start", { prompt_length: 10 }),
      unsealed(
        "subagent_start",
        { tool_use_id: "child-launch" },
        {
          subagent: { subagent_id: "child-1" },
        },
      ),
      unsealed("turn_end", {
        last_assistant_message_digest: `sha256:${"a".repeat(64)}`,
      }),
    ]);
    writeFileSync(f.options.evidenceFile, JSON.stringify(events));
    f.brief.boundary_digest = events[events.length - 1]?.hash;
    f.saveBrief();
    expect(() => captureCheckpoint(f.options)).toThrow(
      /child|subagent|active/i,
    );
    expect(existsSync(f.options.out)).toBe(false);
  });

  it.each(["../outside.txt", "/etc/passwd", "bin/../../outside.txt"])(
    "refuses workspace path %s",
    async (path) => {
      const f = fixture();
      f.brief.files = [path];
      f.saveBrief();
      expect(() => captureCheckpoint(f.options)).toThrow(
        /path|relative|travers/i,
      );
      expect(existsSync(f.options.out)).toBe(false);
    },
  );

  it("refuses symlink files even when their target is inside the workspace", async () => {
    const f = fixture();
    symlinkSync("main.ts", join(f.workspace, "alias.ts"));
    f.brief.files = ["alias.ts"];
    f.saveBrief();
    expect(() => captureCheckpoint(f.options)).toThrow(/symlink|symbolic/i);
    expect(existsSync(f.options.out)).toBe(false);
  });

  it("refuses a symlink in a selected file's parent path", async () => {
    const f = fixture();
    mkdirSync(join(f.root, "external"));
    writeFileSync(
      join(f.root, "external", "private.txt"),
      "outside the source workspace",
    );
    symlinkSync(join(f.root, "external"), join(f.workspace, "linked"));
    f.brief.files = ["linked/private.txt"];
    f.saveBrief();
    expect(() => captureCheckpoint(f.options)).toThrow(/symlink|symbolic/i);
    expect(existsSync(f.options.out)).toBe(false);
  });

  it("refuses secret-bearing content without silently redacting source bytes", async () => {
    const f = fixture();
    const secret = deviceKeyPem(generateDeviceKey());
    writeFileSync(join(f.workspace, "main.ts"), secret);
    expect(() => captureCheckpoint(f.options)).toThrow(
      /secret|private key|sensitive|credential/i,
    );
    expect(readFileSync(join(f.workspace, "main.ts"), "utf8")).toBe(secret);
    expect(existsSync(f.options.out)).toBe(false);
  });
});
