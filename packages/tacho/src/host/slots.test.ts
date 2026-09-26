/**
 * Enrollment slots (ADR-202): which files move into a slot, which slot holds
 * a harness, and which ports and harnesses another agent on the same
 * machine holds.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type HostFile, writeHostFile } from "./host-file";
import type { TachoPaths } from "./paths";
import {
  describeSlot,
  enrolledSlots,
  harnessesHeldElsewhere,
  listSlots,
  liveSubSlots,
  otherLiveSlots,
  portsInUse,
  type Slot,
  SLOTS_DIR,
  slotForHarness,
  slotHolding,
  slotIsLive,
  slotPaths,
  slotPathsForEnrollment,
} from "./slots";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "./test-support";

const CODEX_ENROLLMENT = "tch_zyxwvutsrqpnmkjhgfedcb";

function host(overrides: Partial<HostFile> = {}): HostFile {
  const signer = bundleSigner();
  return testHostFile(signer, signer.sign(unsignedBundle()), overrides);
}

/**
 * A machine with two agents: Claude Code enrolled at the root on port
 * 47001, and Codex in its own slot on port 47011.
 */
function twoAgents(codexOverrides: Partial<HostFile> = {}): {
  root: TachoPaths;
  codex: TachoPaths;
} {
  const root = scratchPaths();
  writeHostFile(root.hostFile, host());
  const codex = slotPaths(root, "codex");
  writeHostFile(
    codex.hostFile,
    host({
      host_enrollment_id: CODEX_ENROLLMENT,
      agent_key: "acme.core.codex-laptop",
      harnesses: ["codex"],
      port: 47011,
      ...codexOverrides,
    }),
  );
  return { root, codex };
}

/** The Codex slot of a machine `twoAgents` made. */
function codexSlot(root: TachoPaths): Slot {
  const slot = listSlots(root)[1];
  if (slot === undefined) throw new Error("no Codex slot");
  return slot;
}

describe("slotPaths", () => {
  it("moves the enrollment's own files into agents/<harness> and leaves the harness config where the root found it", () => {
    const root = scratchPaths();
    const codex = slotPaths(root, "codex");
    const dir = join(root.root, SLOTS_DIR, "codex");
    expect(codex.root).toBe(dir);
    for (const key of [
      "hostFile",
      "deviceKey",
      "credentials",
      "socket",
      "wal",
      "spool",
      "quarantine",
      "pid",
      "log",
    ] as const)
      expect(codex[key]).toBe(join(dir, basename(root[key])));
    for (const key of [
      "claudeSettings",
      "claudeProjects",
      "codexHooks",
      "cursorHooks",
      "stellaToml",
      "stellaSettingsJson",
      "claudeDesktopConfig",
    ] as const)
      expect(codex[key]).toEqual(root[key]);
  });
});

describe("listSlots", () => {
  it("lists the root first, then each slot with a host.json, and skips any other directory", () => {
    const root = scratchPaths();
    expect(listSlots(root)).toEqual([
      { harness: undefined, paths: root, host: undefined },
    ]);
    expect(enrolledSlots(root)).toEqual([]);

    const machine = twoAgents().root;
    const slotsDir = join(machine.root, SLOTS_DIR);
    // A slot directory with no host.json, and a directory named for no
    // harness, are not enrollments.
    mkdirSync(join(slotsDir, "cursor"), { recursive: true });
    mkdirSync(join(slotsDir, "not-a-harness"), { recursive: true });
    writeFileSync(join(slotsDir, "not-a-harness", "host.json"), "{}");

    const slots = listSlots(machine);
    expect(slots.map((slot) => slot.harness)).toEqual([undefined, "codex"]);
    expect(slots.map((slot) => slot.host?.host_enrollment_id)).toEqual([
      TEST_ENROLLMENT,
      CODEX_ENROLLMENT,
    ]);
  });

  it("counts a slot as enrolled without a root enrollment, and the root only when its host.json is there", () => {
    const { root } = twoAgents();
    expect(enrolledSlots(root).map((slot) => slot.harness)).toEqual([
      undefined,
      "codex",
    ]);

    const bare = scratchPaths();
    const codex = slotPaths(bare, "codex");
    writeHostFile(
      codex.hostFile,
      host({ host_enrollment_id: CODEX_ENROLLMENT, harnesses: ["codex"] }),
    );
    expect(enrolledSlots(bare).map((slot) => slot.harness)).toEqual(["codex"]);
    expect(liveSubSlots(bare).map((slot) => slot.paths.root)).toEqual([
      codex.root,
    ]);
  });
});

describe("live slots", () => {
  it("treats a slot retired here, or revoked on the fleet page, as no longer holding its harness", () => {
    const retired = twoAgents({ revoked_at: "2026-09-20T00:00:00.000Z" });
    expect(slotIsLive(codexSlot(retired.root))).toBe(false);
    expect(liveSubSlots(retired.root)).toEqual([]);
    expect(slotHolding(retired.root, "codex")).toBeUndefined();
    expect(describeSlot(codexSlot(retired.root))).toBe(
      "codex as acme.core.codex-laptop (retired on this machine)",
    );

    const fleet = twoAgents({ host_status: "revoked" });
    expect(slotIsLive(codexSlot(fleet.root))).toBe(false);
    expect(slotHolding(fleet.root, "codex")).toBeUndefined();
    expect(describeSlot(codexSlot(fleet.root))).toBe(
      "codex as acme.core.codex-laptop (revoked on the fleet page)",
    );
  });

  it("names an unreadable enrollment by its directory", () => {
    const { root, codex } = twoAgents();
    writeFileSync(codex.hostFile, "{ not json");
    const slot = codexSlot(root);
    expect(slot.host).toBeUndefined();
    expect(slotIsLive(slot)).toBe(false);
    expect(describeSlot(slot)).toBe(
      `an unreadable enrollment in ${codex.root}`,
    );
  });
});

describe("the slot that holds a harness", () => {
  it("finds the live slot that hooks each harness, and none for a harness no agent hooks", () => {
    const { root, codex } = twoAgents();
    expect(slotHolding(root, "claude-code")?.paths.root).toBe(root.root);
    expect(slotHolding(root, "codex")?.paths.root).toBe(codex.root);
    expect(slotHolding(root, "cursor")).toBeUndefined();
    expect(describeSlot(codexSlot(root))).toBe(
      "codex as acme.core.codex-laptop",
    );
  });

  it("falls back to a retired slot, then to the directory made for the harness, so an unenroll can still clear it", () => {
    const retired = twoAgents({ revoked_at: "2026-09-20T00:00:00.000Z" });
    expect(slotForHarness(retired.root, "codex")?.paths.root).toBe(
      retired.codex.root,
    );

    const unreadable = twoAgents();
    writeFileSync(unreadable.codex.hostFile, "{ not json");
    const slot = slotForHarness(unreadable.root, "codex");
    expect(slot?.paths.root).toBe(unreadable.codex.root);
    expect(slot?.host).toBeUndefined();
    expect(slotForHarness(unreadable.root, "cursor")).toBeUndefined();
  });

  it("routes a hook by the enrollment id it carries, and sends an unknown id to the root", () => {
    const { root, codex } = twoAgents();
    expect(slotPathsForEnrollment(root, CODEX_ENROLLMENT)).toEqual(codex);
    expect(slotPathsForEnrollment(root, TEST_ENROLLMENT)).toBe(root);
    expect(slotPathsForEnrollment(root, undefined)).toBe(root);
    expect(slotPathsForEnrollment(root, "tch_unknown")).toBe(root);

    // A retired slot still answers its own stale hook entries.
    const retired = twoAgents({ revoked_at: "2026-09-20T00:00:00.000Z" });
    expect(slotPathsForEnrollment(retired.root, CODEX_ENROLLMENT)).toEqual(
      retired.codex,
    );
  });
});

describe("what another agent holds", () => {
  it("lists the other live slots and the harnesses they hook", () => {
    const { root, codex } = twoAgents();
    expect(
      otherLiveSlots(root, codex.root).map((slot) => slot.paths.root),
    ).toEqual([root.root]);
    expect(harnessesHeldElsewhere(root, codex.root)).toEqual(
      new Set(["claude-code"]),
    );
    expect(harnessesHeldElsewhere(root, root.root)).toEqual(new Set(["codex"]));

    const retired = twoAgents({ revoked_at: "2026-09-20T00:00:00.000Z" });
    expect(otherLiveSlots(retired.root, retired.root.root)).toEqual([]);
    expect(harnessesHeldElsewhere(retired.root, retired.root.root)).toEqual(
      new Set(),
    );
  });

  it("reserves each live slot's collector port and model proxy port", () => {
    const { root, codex } = twoAgents();
    expect(portsInUse(root)).toEqual(new Set([47001, 47002, 47011, 47012]));
    expect(portsInUse(root, codex.root)).toEqual(new Set([47001, 47002]));

    const pinned = twoAgents({ model_proxy_port: 47100 });
    expect(portsInUse(pinned.root)).toEqual(
      new Set([47001, 47002, 47011, 47100]),
    );

    const retired = twoAgents({ revoked_at: "2026-09-20T00:00:00.000Z" });
    expect(portsInUse(retired.root)).toEqual(new Set([47001, 47002]));
  });
});
