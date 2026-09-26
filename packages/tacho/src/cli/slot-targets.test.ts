/**
 * Which enrollment slot `enroll`, `unenroll` and `reassign` act on when a
 * machine holds more than one agent (ADR-202), and the deps a command gets
 * once it is bound to a slot.
 */
import { describe, expect, it } from "vitest";
import { type HostFile, writeHostFile } from "../host/host-file";
import type { TachoPaths } from "../host/paths";
import { listSlots, type Slot, slotPaths } from "../host/slots";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { CliDeps } from "./deps";
import { enrollTarget } from "./enroll";
import { reassignTarget } from "./reassign";
import {
  depsForHarness,
  depsForSlot,
  rootPathsOf,
  slotDeps,
} from "./slot-deps";
import { unenrollTarget } from "./unenroll";

const CODEX_ENROLLMENT = "tch_zyxwvutsrqpnmkjhgfedcb";
const TOKEN = "oxe_1time_0123456789abcdefghjkmnpqrs";
const RETIRED = { revoked_at: "2026-09-20T00:00:00.000Z" };

function host(overrides: Partial<HostFile> = {}): HostFile {
  const signer = bundleSigner();
  return testHostFile(signer, signer.sign(unsignedBundle()), overrides);
}

/** Claude Code enrolled at the root of a fresh machine. */
function oneAgent(overrides: Partial<HostFile> = {}): TachoPaths {
  const root = scratchPaths();
  writeHostFile(root.hostFile, host(overrides));
  return root;
}

/** Codex enrolled in its own slot beside whatever `root` holds. */
function addCodex(
  root: TachoPaths,
  overrides: Partial<HostFile> = {},
): TachoPaths {
  const codex = slotPaths(root, "codex");
  writeHostFile(
    codex.hostFile,
    host({
      host_enrollment_id: CODEX_ENROLLMENT,
      agent_key: "acme.core.codex-laptop",
      harnesses: ["codex"],
      port: 47011,
      ...overrides,
    }),
  );
  return codex;
}

/** The root slot `unenrollTarget` and `reassignTarget` fall back to. */
function bareRoot(root: TachoPaths): Slot {
  return { harness: undefined, paths: root, host: undefined };
}

const BOTH =
  "claude-code as acme.core.cc-laptop; codex as acme.core.codex-laptop";

describe("enrollTarget", () => {
  it("enrolls a fresh machine at the root", () => {
    const root = scratchPaths();
    expect(
      enrollTarget({ harnesses: ["codex"], enrollmentToken: TOKEN }, root),
    ).toEqual({ paths: root });
  });

  it("gives a second agent's token a slot of its own", () => {
    const root = oneAgent();
    expect(
      enrollTarget({ harnesses: ["codex"], enrollmentToken: TOKEN }, root),
    ).toEqual({ paths: slotPaths(root, "codex") });
    // A third agent, beside a machine that already holds two.
    addCodex(root);
    expect(
      enrollTarget({ harnesses: ["cursor"], enrollmentToken: TOKEN }, root),
    ).toEqual({ paths: slotPaths(root, "cursor") });
  });

  it("keeps a harness in the slot that already holds it", () => {
    const root = oneAgent();
    const codex = addCodex(root);
    expect(
      enrollTarget(
        { harnesses: ["claude-code"], enrollmentToken: TOKEN },
        root,
      ),
    ).toEqual({ paths: root });
    expect(
      enrollTarget({ harnesses: ["codex"], enrollmentToken: TOKEN }, root),
    ).toEqual({ paths: codex });
    expect(enrollTarget({ harnesses: ["codex"] }, root)).toEqual({
      paths: codex,
    });
  });

  it("adds a harness to the root's enrollment when the operator enrolls without a token", () => {
    const root = oneAgent();
    expect(enrollTarget({ harnesses: ["codex"] }, root)).toEqual({
      paths: root,
    });
  });

  it("reuses a retired root rather than opening a slot beside it", () => {
    const root = oneAgent(RETIRED);
    expect(
      enrollTarget({ harnesses: ["codex"], enrollmentToken: TOKEN }, root),
    ).toEqual({ paths: root });
  });

  it("refuses one enroll across two agents, and a second agent's token for two harnesses", () => {
    const root = oneAgent();
    addCodex(root);
    const across = enrollTarget(
      { harnesses: ["claude-code", "codex"], enrollmentToken: TOKEN },
      root,
    );
    expect("refusal" in across && across.refusal).toMatch(
      /belong to different agents on this machine \(claude-code as acme\.core\.cc-laptop; codex as acme\.core\.codex-laptop\)/,
    );

    const lone = oneAgent();
    const two = enrollTarget(
      { harnesses: ["codex", "cursor"], enrollmentToken: TOKEN },
      lone,
    );
    expect("refusal" in two && two.refusal).toBe(
      "This machine is enrolled as acme.core.cc-laptop, and a token enrolls one more agent with one harness. Pass one --harness.",
    );
  });
});

describe("unenrollTarget", () => {
  it("takes the one enrollment, or the root on a machine with none", () => {
    const empty = scratchPaths();
    expect(unenrollTarget(empty, undefined)).toEqual(bareRoot(empty));
    expect(unenrollTarget(empty, "codex")).toEqual(bareRoot(empty));

    const root = oneAgent();
    const slot = unenrollTarget(root, undefined);
    expect("paths" in slot && slot.paths).toBe(root);
    expect("host" in slot && slot.host?.agent_key).toBe("acme.core.cc-laptop");

    // One agent, enrolled in a slot after the root's was removed.
    const moved = scratchPaths();
    const codex = addCodex(moved);
    const only = unenrollTarget(moved, undefined);
    expect("paths" in only && only.paths).toEqual(codex);
  });

  it("refuses to pick one of two agents for a command that named neither", () => {
    const root = oneAgent();
    addCodex(root);
    expect(unenrollTarget(root, undefined)).toEqual({
      refused: `this machine holds 2 enrollments: ${BOTH}. Pass --harness to name the one to remove, or --all to remove them all`,
    });
  });

  it("takes the agent that hooks the named harness, retired or not", () => {
    const root = oneAgent();
    const codex = addCodex(root);
    const byCodex = unenrollTarget(root, "codex");
    expect("paths" in byCodex && byCodex.paths).toEqual(codex);
    const byClaude = unenrollTarget(root, "claude-code");
    expect("paths" in byClaude && byClaude.paths).toBe(root);
    expect(unenrollTarget(root, "cursor")).toEqual({
      refused: `no enrollment on this machine hooks cursor. It holds ${BOTH}`,
    });

    const retired = oneAgent();
    const retiredCodex = addCodex(retired, RETIRED);
    const slot = unenrollTarget(retired, "codex");
    expect("paths" in slot && slot.paths).toEqual(retiredCodex);
  });
});

describe("reassignTarget", () => {
  it("takes the one enrollment without --harness", () => {
    const root = oneAgent();
    const slot = reassignTarget(root, undefined);
    expect("paths" in slot && slot.paths).toBe(root);
    const empty = scratchPaths();
    expect(reassignTarget(empty, undefined)).toEqual(bareRoot(empty));
  });

  it("needs --harness to name one of two agents", () => {
    const root = oneAgent();
    const codex = addCodex(root);
    expect(reassignTarget(root, undefined)).toEqual({
      refused: `This machine holds 2 enrollments: ${BOTH}. Pass --harness with the harnesses of the one to reassign.`,
    });
    const byCodex = reassignTarget(root, ["codex", "cursor"]);
    expect("paths" in byCodex && byCodex.paths).toEqual(codex);
    expect(reassignTarget(root, ["claude-code", "codex"])).toEqual({
      refused: `--harness names the harnesses of more than one agent: ${BOTH}. Reassign one agent at a time.`,
    });
    expect(reassignTarget(root, ["cursor"])).toEqual({
      refused: `No enrollment on this machine hooks cursor. It holds ${BOTH}. Run \`tacho enroll --harness cursor\` to enroll another agent.`,
    });
  });
});

describe("slot deps", () => {
  function rootDeps(root: TachoPaths): CliDeps {
    return {
      paths: root,
      env: { SLOT: "root" },
      serviceManager: { kind: "launchd" },
      out: () => undefined,
      err: () => undefined,
    } as unknown as CliDeps;
  }

  it("rebinds everything but the service and the terminal to the slot", () => {
    const root = oneAgent();
    const codex = addCodex(root);
    const deps = rootDeps(root);
    expect(slotDeps(deps, root)).toBe(deps);

    const bound = slotDeps(deps, codex);
    expect(bound.paths).toBe(codex);
    expect(bound.rootPaths).toBe(root);
    expect(rootPathsOf(bound)).toBe(root);
    expect(bound.serviceManager).toBe(deps.serviceManager);
    expect(bound.out).toBe(deps.out);
    expect(bound.err).toBe(deps.err);

    // Back from the slot to the root: the root is its own root again.
    const back = slotDeps(bound, root);
    expect(back.paths).toBe(root);
    expect(back.rootPaths).toBeUndefined();
    expect(rootPathsOf(back)).toBe(root);
  });

  it("builds the slot's deps with atSlot when the CLI provides it", () => {
    const root = oneAgent();
    const codex = addCodex(root);
    const deps = rootDeps(root);
    deps.atSlot = (paths) =>
      ({
        ...rootDeps(paths),
        env: { SLOT: "codex" },
        serviceManager: { kind: "other" },
      }) as unknown as CliDeps;
    const bound = slotDeps(deps, codex);
    expect(bound.env).toEqual({ SLOT: "codex" });
    expect(bound.paths).toBe(codex);
    expect(bound.serviceManager).toBe(deps.serviceManager);
    expect(bound.out).toBe(deps.out);
  });

  it("routes a harness to the agent that hooks it, and anything else to the root", () => {
    const root = oneAgent();
    const codex = addCodex(root);
    const deps = rootDeps(root);
    expect(depsForHarness(deps, "codex").paths).toEqual(codex);
    expect(depsForHarness(deps, "codex").rootPaths).toBe(root);
    expect(depsForHarness(deps, "claude-code")).toBe(deps);
    expect(depsForHarness(deps, "cursor")).toBe(deps);

    // A command already bound to a slot still finds the others by the root.
    const bound = slotDeps(deps, codex);
    expect(depsForHarness(bound, "claude-code").paths).toBe(root);

    const [rootSlot, codexSlot] = listSlots(root);
    expect(rootSlot && depsForSlot(deps, rootSlot)).toBe(deps);
    expect(codexSlot && depsForSlot(deps, codexSlot).paths).toEqual(codex);
  });
});
