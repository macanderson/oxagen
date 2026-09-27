import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addHarnessArgs,
  ago,
  busyHoldsClose,
  drivable,
  withoutCommandLine,
  collectorText,
  deregisterNeedsSession,
  HARNESS_TIER,
  isConnected,
  isWrapped,
  verifiable,
  TIER_LABEL,
  TIER_OMITS,
  TIER_RECORDS,
  defaultRegistration,
  deregisterArgs,
  describeCliInstall,
  HARNESS_LABEL,
  HARNESSES,
  workspaceUrl,
  wizardStep,
  enforcementText,
  enrollArgs,
  loginArgs,
  needsWorkspacePick,
  pendingChange,
  primaryAction,
  reapplyArgs,
  reassignArgs,
  sessionLanded,
  type SidecarCall,
  detectArgs,
  detectedMeta,
  logoutArgs,
  registrable,
  statusArgs,
  toggleHarness,
  unenrollArgs,
  verifyArgs,
} from "./commands";

const HOST = {
  org_slug: "acme",
  workspace_slug: "core",
  harnesses: ["claude-code"],
};
const NONE = { org: null, workspace: null, harnesses: null };

describe("sidecar argv", () => {
  it("signs in with the browser flow forced, since the sidecar has no TTY", () => {
    // A bare `login` in a piped child refuses without a token and, with a
    // session saved, prints it and exits 0; only --browser reaches PKCE.
    expect(loginArgs()).toEqual(["login", "--browser"]);
    expect(loginArgs({ signup: true })).toEqual([
      "login",
      "--browser",
      "--signup",
    ]);
  });

  it("says how enforcement works for what was registered (ADR-095)", () => {
    expect(enforcementText(["claude-code", "stella"])).toBe(
      "enforcement is client-attested (the hooks the agents honour)",
    );
    // A connected app has no hook to honour.
    expect(enforcementText(["claude-desktop"])).toBe(
      "connected apps are checked on the server for the Oxagen tools they call",
    );
    expect(enforcementText(["cursor", "claude-desktop"])).toBe(
      "wrapped agents are client-attested (the hooks the agents honour), and connected apps are checked on the server for the Oxagen tools they call",
    );
  });

  it("enrolls with the picked org, workspace, and harness list", () => {
    expect(enrollArgs({ ...NONE, harnesses: ["cursor", "stella"] })).toEqual([
      "enroll",
      "--harness",
      "cursor,stella",
    ]);
    // No agent is registered on the operator's behalf (ADR-101), and an
    // empty pick never reaches tacho as `--harness ""`.
    expect(() => enrollArgs(NONE)).toThrow(/pick at least one agent/);
    expect(() => enrollArgs({ ...NONE, harnesses: [] })).toThrow(
      /pick at least one agent/,
    );
    // An org without a workspace never reaches tacho: it would fill the
    // workspace from config.json, the previous org's.
    expect(() =>
      enrollArgs({ org: "other", workspace: null, harnesses: null }),
    ).toThrow(/pick a workspace in other/);
    expect(
      enrollArgs({
        org: "acme",
        workspace: "edge",
        harnesses: ["claude-code", "codex"],
      }),
    ).toEqual([
      "enroll",
      "--org",
      "acme",
      "--workspace",
      "edge",
      "--harness",
      "claude-code,codex",
    ]);
  });

  it("reassigns with only what differs from the host", () => {
    expect(pendingChange(HOST, NONE)).toEqual({
      target: false,
      harness: false,
    });
    expect(reassignArgs(HOST, { ...NONE, workspace: "edge" })).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--workspace", "edge"],
    });
    expect(
      reassignArgs(HOST, { org: "other", workspace: "main", harnesses: null }),
    ).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--org", "other", "--workspace", "main"],
    });
    // Harness-only change: no --workspace, so tacho re-enrolls in place.
    expect(
      reassignArgs(HOST, { ...NONE, harnesses: ["claude-code", "codex"] }),
    ).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--harness", "claude-code,codex"],
    });
    // Picking the current values is not a change.
    expect(
      pendingChange(HOST, {
        org: "acme",
        workspace: "core",
        harnesses: ["claude-code"],
      }),
    ).toEqual({ target: false, harness: false });
    // Not enrolled: nothing is pending.
    expect(pendingChange(null, { ...NONE, workspace: "edge" })).toEqual({
      target: false,
      harness: false,
    });
  });

  it("treats an org change as incomplete until a workspace in it is picked", () => {
    // Resetting the workspace on an org change leaves the host's slug as the
    // only candidate, and it names a workspace of the old org: no argv until
    // the operator picks one in the new org.
    const orgOnly = { org: "other", workspace: null, harnesses: null };
    expect(needsWorkspacePick("acme", orgOnly)).toBe(true);
    expect(needsWorkspacePick("acme", { org: "acme", workspace: null })).toBe(
      false,
    );
    expect(needsWorkspacePick("acme", { org: "other", workspace: "x" })).toBe(
      false,
    );
    expect(needsWorkspacePick(null, { org: "other", workspace: null })).toBe(
      true,
    );
    expect(pendingChange(HOST, orgOnly)).toEqual({
      target: false,
      harness: false,
    });
    expect(() => reassignArgs(HOST, orgOnly)).toThrow(
      /pick a workspace in other/,
    );
    expect(() => reassignArgs(HOST, orgOnly, true)).toThrow(
      /pick a workspace in other/,
    );
    // Picking the host's own org back is not an org change.
    expect(pendingChange(HOST, { ...orgOnly, org: "acme" })).toEqual({
      target: false,
      harness: false,
    });
  });

  it("calls a sign-in done once its session is on disk, not once the process exits", () => {
    const out = { logged_in: false, org_slug: null, workspace_slug: null };
    const inAcme = {
      logged_in: true,
      org_slug: "acme",
      workspace_slug: "core",
    };
    // A first sign-in: nothing to something.
    expect(sessionLanded(out, inAcme)).toBe(true);
    // Still nothing on disk: the login has not finished.
    expect(sessionLanded(out, out)).toBe(false);
    // Switching organization: the new pair is the evidence.
    expect(sessionLanded(inAcme, { ...inAcme, org_slug: "other" })).toBe(true);
    expect(sessionLanded(inAcme, { ...inAcme, workspace_slug: "edge" })).toBe(
      true,
    );
    // Re-signing in to the same pair writes nothing this can see, so the
    // process close stays the only finish line for that one.
    expect(sessionLanded(inAcme, inAcme)).toBe(false);
    // A sign-out mid-flight is not a landing.
    expect(sessionLanded(inAcme, out)).toBe(false);
  });

  it("reassigns through the oxagen sidecar with --default when the CLI default should follow", () => {
    // config.json is the CLI's file, so making the new pair the CLI default
    // means running the same reassign as `oxagen tacho reassign … --default`.
    expect(
      reassignArgs(
        HOST,
        { org: "other", workspace: "main", harnesses: null },
        true,
      ),
    ).toEqual({
      sidecar: "oxagen",
      args: [
        "tacho",
        "reassign",
        "--org",
        "other",
        "--workspace",
        "main",
        "--default",
      ],
    });
    // A harness-only apply still goes through oxagen when asked: the pair
    // written is the host's current one, so config.json lands in step.
    expect(reassignArgs(HOST, { ...NONE, harnesses: ["codex"] }, true)).toEqual(
      {
        sidecar: "oxagen",
        args: ["tacho", "reassign", "--harness", "codex", "--default"],
      },
    );
    // Explicit false is the plain tacho form.
    expect(reassignArgs(HOST, { ...NONE, workspace: "edge" }, false)).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--workspace", "edge"],
    });
  });

  it("unenroll takes every agent, and carries --purge only on request", () => {
    expect(unenrollArgs(false)).toEqual(["unenroll", "--all"]);
    expect(unenrollArgs(true)).toEqual(["unenroll", "--all", "--purge"]);
  });

  it("never empties the harness list", () => {
    expect(toggleHarness(["claude-code"], "codex")).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(toggleHarness(["claude-code", "codex"], "claude-code")).toEqual([
      "codex",
    ]);
    expect(toggleHarness(["codex"], "codex")).toEqual(["codex"]);
  });
});

describe("panel helpers", () => {
  it("formats relative time", () => {
    const now = Date.parse("2026-09-13T12:00:00Z");
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-09-13T11:59:30Z", now)).toBe("30s ago");
    expect(ago("2026-09-13T11:30:00Z", now)).toBe("30m ago");
    expect(ago("2026-09-13T09:00:00Z", now)).toBe("3h ago");
    expect(ago("2026-09-10T12:00:00Z", now)).toBe("3d ago");
    expect(ago("not a date", now)).toBe("not a date");
  });

  it("puts the one gold action on the next step, never on a destructive one", () => {
    const none = { target: false, harness: false };
    expect(primaryAction(false, false, none)).toBe("signin");
    expect(primaryAction(true, false, none)).toBe("enroll");
    expect(primaryAction(true, true, none)).toBeNull();
    expect(primaryAction(true, true, { target: true, harness: false })).toBe(
      "apply",
    );
    expect(primaryAction(true, true, { target: false, harness: true })).toBe(
      "apply",
    );
  });
});

describe("wizard and de-register", () => {
  it("derives the step from the machine state so a relaunch resumes", () => {
    const base = {
      loggedIn: false,
      targetChosen: false,
      enrolled: false,
      outcomeSeen: false,
    };
    expect(wizardStep(base)).toBe(1);
    expect(wizardStep({ ...base, loggedIn: true })).toBe(2);
    expect(wizardStep({ ...base, loggedIn: true, targetChosen: true })).toBe(3);
    expect(wizardStep({ ...base, loggedIn: true, enrolled: true })).toBe(4);
    expect(
      wizardStep({
        ...base,
        loggedIn: true,
        enrolled: true,
        outcomeSeen: true,
      }),
    ).toBe(5);
    // Signed out after enrolling: back to step 1, never a half state.
    expect(wizardStep({ ...base, enrolled: true, outcomeSeen: true })).toBe(1);
  });

  it("ticks every detected agent by default and none of the absent ones", () => {
    expect(
      defaultRegistration([
        { harness: "claude-code", installed: true },
        { harness: "codex", installed: false },
      ]),
    ).toEqual(["claude-code"]);
    expect(
      defaultRegistration([
        { harness: "claude-code", installed: true },
        { harness: "codex", installed: true },
      ]),
    ).toEqual(["claude-code", "codex"]);
    expect(defaultRegistration([])).toEqual([]);
  });

  it("de-registers one agent by re-enrolling with the rest, or unenrolls the last", () => {
    expect(deregisterArgs(["claude-code", "codex"], "codex")).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--harness", "claude-code"],
    });
    // Named, so another agent enrolled on the machine keeps its enrollment.
    expect(deregisterArgs(["claude-code"], "claude-code")).toEqual({
      sidecar: "tacho",
      args: ["unenroll", "--harness", "claude-code"],
    });
  });

  it("needs a live sign-in to de-register when agents would remain, not for the last one", () => {
    // `reassign` revokes, then enrolls again with the session.
    expect(deregisterNeedsSession(["claude-code", "codex"], "codex")).toBe(
      true,
    );
    expect(
      deregisterNeedsSession(
        ["claude-code", "claude-desktop"],
        "claude-desktop",
      ),
    ).toBe(true);
    // `unenroll` finishes offline.
    expect(deregisterNeedsSession(["claude-code"], "claude-code")).toBe(false);
  });

  it("says the collector is not answering rather than starting", () => {
    expect(collectorText(true, 47001)).toBe("running on 127.0.0.1:47001");
    expect(collectorText(false, 47001)).toBe(
      "not answering on 127.0.0.1:47001",
    );
  });

  it("links the workspace root the host reports to, not the nonexistent /runs", () => {
    expect(workspaceUrl("https://app.oxagen.sh/", "acme", "core")).toBe(
      "https://app.oxagen.sh/acme/core",
    );
    expect(workspaceUrl("https://app.oxagen.sh", "a b", "c/d")).toBe(
      "https://app.oxagen.sh/a%20b/c%2Fd",
    );
  });

  it("lists every AI app the machine can put under Oxagen, labeled", () => {
    expect(HARNESSES).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "stella",
      "claude-desktop",
    ]);
    for (const h of HARNESSES) expect(HARNESS_LABEL[h]).toBeTruthy();
    expect(HARNESS_LABEL.stella).toBe("stella");
    expect(HARNESS_LABEL.cursor).toBe("Cursor");
  });

  it("gives every app a tier, and the two predicates agree with it", () => {
    // Mirrors TACHO_HARNESS_TIERS in packages/tacho/src/wire.ts. The desktop
    // app shares no runtime code with the CLIs it drives, so the list is
    // written twice and this is where the two meet: an app added here without
    // a tier fails, rather than defaulting to wrapped.
    for (const h of HARNESSES) {
      expect(HARNESS_TIER[h]).toMatch(/^(harness|gateway)$/);
      expect(isWrapped(h)).toBe(HARNESS_TIER[h] === "harness");
      expect(isConnected(h)).toBe(HARNESS_TIER[h] === "gateway");
      expect(isWrapped(h)).not.toBe(isConnected(h));
    }
    expect(HARNESS_TIER["claude-code"]).toBe("harness");
    expect(HARNESS_TIER.cursor).toBe("harness");
    expect(HARNESS_TIER["claude-desktop"]).toBe("gateway");
  });

  it("keeps connected apps out of the list tacho verify is run on", () => {
    // `verify` drives a headless turn and waits for the sealed hook chain, so
    // it returns ok:false for a connected app by design. The wizard used to
    // hand it every registered app, which on a Claude-Desktop-only machine made
    // the one line in "record a first run" read "failed" for something that
    // cannot succeed and did not go wrong.
    expect(verifiable(HARNESSES)).toEqual(HARNESSES.filter(isWrapped));
    expect(verifiable(["claude-desktop"])).toEqual([]);
    expect(verifiable(["claude-code", "claude-desktop"])).toEqual([
      "claude-code",
    ]);
    expect(verifiable([])).toEqual([]);
    for (const h of verifiable(HARNESSES)) expect(isConnected(h)).toBe(false);
  });

  it("says what each tier records and what it does not, for both tiers", () => {
    for (const tier of ["harness", "gateway"] as const) {
      expect(TIER_LABEL[tier]).toBeTruthy();
      expect(TIER_RECORDS[tier]).toBeTruthy();
      // ADR-078 §2: the omission line is as mandatory as the records line.
      // A surface that shows only what a tier captures reads as coverage it
      // does not have.
      expect(TIER_OMITS[tier]).toBeTruthy();
    }
    expect(TIER_LABEL.harness).toBe("Wrapped");
    expect(TIER_LABEL.gateway).toBe("Connected");
    // The wrapped caveat is the client-attestation one; the connected caveat
    // is the narrowness one. Neither is worded as a ranking.
    expect(TIER_OMITS.harness).toContain("does not run this agent");
    expect(TIER_OMITS.gateway).toContain("Not your prompts");
    for (const text of [
      ...Object.values(TIER_RECORDS),
      ...Object.values(TIER_OMITS),
    ]) {
      expect(text.toLowerCase()).not.toContain("full");
      expect(text.toLowerCase()).not.toContain("partial");
      expect(text.toLowerCase()).not.toContain("limited");
    }
  });
});

describe("describeCliInstall", () => {
  it("has nothing to say when the build predates the field", () => {
    expect(describeCliInstall(null)).toBeNull();
    expect(describeCliInstall(undefined)).toBeNull();
  });

  it("describes what the launch-time link did, per state", () => {
    const base = {
      dir: "/Users/a/.local/bin",
      files: ["oxagen", "tacho"],
      skipped: [],
      profile: null,
      note: "",
    };
    expect(
      describeCliInstall({ ...base, state: "linked", profile: "~/.zshrc" }),
    ).toBe(
      "Linked oxagen, tacho into /Users/a/.local/bin on launch. Updated ~/.zshrc.",
    );
    expect(
      describeCliInstall({
        ...base,
        state: "linked",
        skipped: ["stella (already a symlink to another install)"],
      }),
    ).toBe(
      "Linked oxagen, tacho into /Users/a/.local/bin on launch. Skipped stella (already a symlink to another install).",
    );
    // The Rust side never populates `files` for "already" (nothing needed
    // linking), so the copy must not depend on it or read "nothing already
    // on PATH".
    expect(describeCliInstall({ ...base, files: [], state: "already" })).toBe(
      "Already on PATH in /Users/a/.local/bin.",
    );
    // "linked" can also carry an empty `files` list (every link was already
    // correct on launch): the same "nothing to report" copy, not "Linked
    // nothing into ...". The profile check still runs every launch, so a
    // set profile still shows even when nothing needed linking.
    expect(
      describeCliInstall({
        ...base,
        files: [],
        state: "linked",
        profile: "~/.zshrc",
      }),
    ).toBe("Already on PATH in /Users/a/.local/bin. Updated ~/.zshrc.");
    expect(
      describeCliInstall({
        ...base,
        files: [],
        state: "already",
        skipped: ["stella (already a symlink to another install)"],
      }),
    ).toBe(
      "Already on PATH in /Users/a/.local/bin. Skipped stella (already a symlink to another install).",
    );
    expect(
      describeCliInstall({
        ...base,
        state: "skipped",
        note: "no writable bin dir",
      }),
    ).toBe("Skipped linking on launch: no writable bin dir");
    expect(
      describeCliInstall({
        ...base,
        state: "opted_out",
        note: "OXAGEN_NO_PATH_LINK set",
      }),
    ).toBe("Not linked: you opted out. OXAGEN_NO_PATH_LINK set");
    expect(
      describeCliInstall({
        ...base,
        state: "failed",
        note: "permission denied",
      }),
    ).toBe("Could not link into /Users/a/.local/bin: permission denied");
    expect(describeCliInstall({ ...base, state: "pending" })).toBe(
      "Linking on launch…",
    );
    // An unrecognized state (a newer CLI, an older app) falls back to its note.
    expect(
      describeCliInstall({
        ...base,
        // @ts-expect-error exercising the unrecognized-state fallback
        state: "future-state",
        note: "see the log",
      }),
    ).toBe("see the log");
  });
});

/**
 * One of each argv the panels send, from the builders above. The Rust shell
 * runs a sidecar only when its allowlist accepts the argv
 * (`src-tauri/src/sidecar.rs`), and its test reads this list from
 * `src-tauri/sidecar-calls.json`. Here the file is checked against the
 * builders, there against the allowlist, so a builder that starts sending a
 * new argv fails one of the two until the allowlist takes it (#4318, D-12).
 */
function everyCall(): SidecarCall[] {
  const tacho = (args: string[]): SidecarCall => ({ sidecar: "tacho", args });
  const oxagen = (args: string[]): SidecarCall => ({ sidecar: "oxagen", args });
  return [
    oxagen(loginArgs()),
    oxagen(loginArgs({ signup: true })),
    oxagen(logoutArgs()),
    tacho(statusArgs()),
    tacho(detectArgs()),
    ...verifiable(HARNESSES).map((h) => tacho(verifyArgs(h))),
    tacho(
      enrollArgs({
        org: "acme",
        workspace: "core",
        harnesses: ["claude-code", "codex"],
      }),
    ),
    tacho(enrollArgs({ org: null, workspace: "core", harnesses: HARNESSES })),
    tacho(enrollArgs({ org: null, workspace: null, harnesses: ["cursor"] })),
    reassignArgs(HOST, { org: "globex", workspace: "ops", harnesses: null }),
    reassignArgs(HOST, { org: null, workspace: "ops", harnesses: null }),
    reassignArgs(
      HOST,
      { org: "globex", workspace: "ops", harnesses: null },
      true,
    ),
    reassignArgs(HOST, { org: null, workspace: "ops", harnesses: null }, true),
    reassignArgs(HOST, {
      org: null,
      workspace: null,
      harnesses: ["claude-code", "stella"],
    }),
    deregisterArgs(["claude-code", "codex"], "codex"),
    deregisterArgs(["claude-code"], "claude-code"),
    addHarnessArgs(["claude-code"], "claude-desktop"),
    tacho(reapplyArgs()),
    tacho(unenrollArgs(false)),
    tacho(unenrollArgs(true)),
  ];
}

describe("the sidecar allowlist's fixture", () => {
  const fixture = new URL("../src-tauri/sidecar-calls.json", import.meta.url);

  it("holds one of each argv the builders make", () => {
    // UPDATE_SIDECAR_CALLS=1 rewrites the file from the builders.
    if (process.env.UPDATE_SIDECAR_CALLS === "1")
      writeFileSync(fixture, `${JSON.stringify(everyCall(), null, 2)}\n`);
    expect(JSON.parse(readFileSync(fixture, "utf8"))).toEqual(everyCall());
  });

  // The fixture covers only what the builders make, so an argv written
  // inline at a call site reaches the allowlist untested. Re-apply sent a
  // bare `tacho enroll` that way, and the allowlist refused it.
  it("takes every argv a panel sends from a builder", () => {
    const inline = [
      // act("name", sidecar, [ ... ]
      /\bact\(\s*"[^"]*"\s*,\s*[^,()]+,\s*\[/g,
      // runSidecar(sidecar, [ ... ]
      /\brunSidecar\(\s*[^,()]+,\s*\[/g,
    ];
    for (const file of ["app.tsx", "bridge.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const pattern of inline)
        expect(source.match(pattern) ?? [], file).toEqual([]);
    }
  });

  it("re-applies with a bare enroll, which keeps the enrolled list", () => {
    expect(reapplyArgs()).toEqual(["enroll"]);
  });

  it("builds the argv the Rust allowlist names", () => {
    expect(statusArgs()).toEqual(["status", "--json"]);
    expect(detectArgs()).toEqual(["detect", "--json"]);
    expect(verifyArgs("codex")).toEqual([
      "verify",
      "--harness",
      "codex",
      "--json",
    ]);
    expect(logoutArgs()).toEqual(["logout"]);
    expect(addHarnessArgs(["claude-code", "codex"], "cursor")).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--harness", "claude-code,codex,cursor"],
    });
  });
});

// #3367: a Cursor the scan did not find is still coverable, since
// ~/.cursor/hooks.json governs the editor and the CLI alike, and the scan
// cannot see a Linux editor installed as an AppImage (ADR-141).
describe("step 3's rows", () => {
  const note =
    "enrollment writes ~/.cursor/hooks.json, which governs the Cursor editor and the cursor-agent CLI alike";

  it("offers a Cursor the scan did not find, with the coverage note", () => {
    const cursor = { installed: false, coverableWhenAbsent: note };
    expect(registrable(cursor)).toBe(true);
    expect(detectedMeta(cursor)).toBe(`not found by the scan · ${note}`);
  });

  it("offers a Cursor found as the editor, and says so", () => {
    const editor = {
      installed: true,
      foundVia: "app" as const,
      path: "/Applications/Cursor.app",
      coverableWhenAbsent: note,
    };
    expect(registrable(editor)).toBe(true);
    expect(detectedMeta(editor)).toBe("the editor · /Applications/Cursor.app");
  });

  it("still refuses an agent that is absent and not coverable, or has no build here", () => {
    expect(registrable({ installed: false })).toBe(false);
    expect(detectedMeta({ installed: false })).toBe(
      "not found on this machine",
    );
    const linuxDesktop = {
      installed: false,
      unavailableReason: "Claude Desktop has no Linux build",
    };
    expect(registrable(linuxDesktop)).toBe(false);
    expect(detectedMeta(linuxDesktop)).toBe(
      "Claude Desktop has no Linux build",
    );
  });

  it("reads a CLI the way it always did", () => {
    const cli = {
      installed: true,
      foundVia: "cli" as const,
      path: "/usr/local/bin/claude",
      version: "2.1.263",
    };
    expect(registrable(cli)).toBe(true);
    expect(detectedMeta(cli)).toBe("2.1.263 · /usr/local/bin/claude");
    expect(detectedMeta({ installed: true })).toBe("installed");
  });

  it("leaves a Cursor the scan did not find unticked by default", () => {
    expect(
      defaultRegistration([
        { harness: "claude-code", installed: true },
        { harness: "cursor", installed: false },
      ]),
    ).toEqual(["claude-code"]);
  });
});

// #3367 review: registering a Cursor the scan found only as the editor, or
// not at all, handed it to `tacho verify`, which runs `cursor-agent -p` and
// failed with "cursor-agent is not on PATH". That failure was the first thing
// the person saw after registering it.
describe("step 5's first run", () => {
  const scan = [
    { harness: "claude-code", foundVia: "cli" as const },
    { harness: "codex", foundVia: "cli" as const },
    { harness: "cursor" },
    { harness: "claude-desktop", foundVia: "app" as const },
  ];

  it("drives only the agents the scan found as a command line", () => {
    expect(drivable(["claude-code", "cursor", "claude-desktop"], scan)).toEqual(
      ["claude-code"],
    );
    expect(withoutCommandLine("cursor", scan)).toBe(true);
    const editor = [{ harness: "cursor", foundVia: "app" as const }];
    expect(drivable(["cursor"], editor)).toEqual([]);
    expect(withoutCommandLine("cursor", editor)).toBe(true);
    const cli = [{ harness: "cursor", foundVia: "cli" as const }];
    expect(drivable(["cursor"], cli)).toEqual(["cursor"]);
    expect(withoutCommandLine("cursor", cli)).toBe(false);
  });

  it("keeps every wrapped agent when there is no scan to read", () => {
    // A relaunch lands on step 5 with no scan. A failed run then says what
    // is missing.
    expect(drivable(["claude-code", "cursor", "claude-desktop"], null)).toEqual(
      ["claude-code", "cursor"],
    );
    expect(withoutCommandLine("cursor", null)).toBe(false);
    // A connected app is never "without a command line": it has its own row.
    expect(withoutCommandLine("claude-desktop", scan)).toBe(false);
  });
});

// Audit D-11 review: the page reported busy for every action, so a Quit
// during a sign-in hid the window and left the app running for up to the
// five minutes `oxagen login` waits for the browser.
describe("which busy state holds a close", () => {
  it("holds a close while an action changes the machine", () => {
    for (const busy of [
      "enroll",
      "reapply",
      "apply",
      "add",
      "deregister",
      "uninstall",
      "signout",
      "cli",
      "cli-remove",
      "update",
    ])
      expect(busyHoldsClose(busy), busy).toBe(true);
  });

  it("holds none while a sign-in or a first run waits, or while idle", () => {
    for (const busy of ["signin", "signup", "connect", null])
      expect(busyHoldsClose(busy), String(busy)).toBe(false);
  });
});
