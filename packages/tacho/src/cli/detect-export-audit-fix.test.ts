/**
 * `detect` on a host.json it cannot validate, the mode of an export written
 * to a file, and an export on a machine with two agents.
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import { agentPaths, tachoHome } from "../host/paths";
import {
  bundleSigner,
  TEST_AGENT_ID,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { Wal } from "../host/wal";
import { minimalSession } from "../test-helpers";
import { defaultCliDeps } from "./deps";
import { detect } from "./detect";
import { exportCommand } from "./export";

function deps() {
  const home = mkdtempSync(join(tmpdir(), "tacho-detect-export-"));
  const env = { HOME: home, TACHO_HOME: join(home, "tacho") };
  const lines: string[] = [];
  return defaultCliDeps({
    paths: agentPaths(tachoHome(env, home, "darwin"), TEST_AGENT_ID),
    env,
    home,
    platform: "darwin",
    claude: () => ({}),
    codex: () => ({}),
    cursor: () => ({}),
    stella: () => ({}),
    claudeDesktop: () => ({ installed: false }),
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
}

describe("detect", () => {
  it("lists the apps when host.json is cut short or does not validate", () => {
    const d = deps();
    mkdirSync(d.paths.dir, { recursive: true });
    for (const text of ['{"schema":', '{"schema":"tacho.host.v1"}']) {
      writeFileSync(d.paths.hostFile, text);
      const report = detect({}, d);
      expect(report.enrolled).toBe(false);
      expect(report.harnesses.every((h) => !h.enrolled)).toBe(true);
    }
  });
});

describe("export --out", () => {
  it("writes the file private to its owner", async () => {
    const d = deps();
    const events = minimalSession();
    new Wal(d.paths.wal).append(events);
    const out = join(d.paths.dir, "session.ndjson");
    expect(
      await exportCommand(
        { session: events[0]?.session_uuid as string, out },
        d,
      ),
    ).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
});

describe("export on a machine with two agents (ADR-203)", () => {
  it("lists and exports a session only the newer agent's WAL holds", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const d = {
      ...deps(),
      out: (line: string) => lines.push(line),
      err: (line: string) => errors.push(line),
    };
    // `d.paths` is the older agent, the one a command acts on when nothing
    // names an agent. The session is in the newer agent's WAL.
    const newer = agentPaths(d.paths, "b2c3d4e5");
    const signer = bundleSigner();
    writeHostFile(
      d.paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        enrolled_at: "2026-09-10T00:00:00.000Z",
      }),
    );
    writeHostFile(
      newer.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        enrolled_at: "2026-09-11T00:00:00.000Z",
      }),
    );
    const events = minimalSession();
    new Wal(newer.wal).append(events);
    const uuid = events[0]?.session_uuid as string;
    const sessionId = events[0]?.session_id as string;

    expect(await exportCommand({ list: true }, d)).toBe(true);
    expect(lines.at(-1)).toContain(`${uuid}  ${sessionId}`);

    expect(await exportCommand({ session: sessionId, format: "trace" }, d)).toBe(
      true,
    );
    expect(lines.at(-1)).toContain("session_start");
    expect(await exportCommand({ session: uuid }, d)).toBe(true);
    expect(errors).toEqual([]);

    // A session no agent recorded names every WAL it looked in.
    expect(await exportCommand({ session: "nope" }, d)).toBe(false);
    expect(errors.at(-1)).toContain(d.paths.wal);
    expect(errors.at(-1)).toContain(newer.wal);
  });
});
