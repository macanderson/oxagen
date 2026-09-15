import { describe, expect, it } from "vitest";
import { computeAgentRows, HEALTH_LABEL, summarizeAgents } from "./agents";
import type { DaemonAgentSummary, DesktopState, HostView } from "./bridge";
import type { TachoStatus } from "./tacho-status";

const NOW = Date.parse("2026-09-15T12:00:00Z");

function host(overrides: Partial<HostView> = {}): HostView {
  return {
    host_enrollment_id: "tch_1",
    agent_key: "agt_1",
    organization_id: "org_1",
    workspace_id: "ws_1",
    org_slug: "acme",
    workspace_slug: "core",
    api_url: "https://api.oxagen.sh",
    host_status: "active",
    port: 47001,
    hostname: "mac",
    os_user: "mac",
    platform: "darwin",
    harnesses: ["claude-code"],
    managed: false,
    claude_version: "1.2.3",
    claude_execpath: "/usr/local/bin/claude",
    wrapper_version: "2.1.1",
    hook_command: "tacho hook",
    daemon_command: ["tacho", "daemon"],
    enrolled_at: "2026-09-01T00:00:00Z",
    expires_at: "2027-09-01T00:00:00Z",
    revoked_at: null,
    bundle_fetched_at: "2026-09-15T00:00:00Z",
    device_key_fingerprint: "ed25519:abc",
    bundle: { version: 3, mode: "enforce", expires_at: "2027-09-01T00:00:00Z" },
    ...overrides,
  };
}

function state(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    platform: "macos",
    arch: "aarch64",
    app_version: "2.1.1",
    config: {
      path: "/Users/a/.config/oxagen/config.json",
      logged_in: true,
      org_slug: "acme",
      workspace_slug: "core",
      api_url: "https://api.oxagen.sh",
      app_url: "https://app.oxagen.sh",
    },
    host: host(),
    host_path: "/Users/a/.config/oxagen/tacho/host.json",
    daemon: {
      uptime_s: 100,
      spool_depth: 0,
      last_ingest_at: null,
      last_error: null,
    },
    log_path: "/Users/a/.config/oxagen/tacho/tachod.log",
    sidecar_dir: "/Applications/Oxagen.app/Contents/MacOS",
    sidecar_transient: false,
    bin_dir: "/Users/a/.local/bin",
    oxagen_on_path: "/Users/a/.local/bin/oxagen",
    tacho_on_path: "/Users/a/.local/bin/tacho",
    cli_install_dir: "/Users/a/.local/bin",
    ...overrides,
  };
}

function agent(
  overrides: Partial<DaemonAgentSummary> = {},
): DaemonAgentSummary {
  return {
    key: "claude-code",
    runtime: "claude-code",
    harness: "claude-code",
    label: "Claude Code",
    first_seen_at: "2026-09-10T00:00:00Z",
    last_seen_at: "2026-09-15T11:57:00Z",
    sessions_total: 4,
    sessions_live: 0,
    ...overrides,
  };
}

describe("computeAgentRows: not wrapped", () => {
  it("marks a never-seen, unenrolled harness not_wrapped", () => {
    const s = state({ host: null, daemon: null });
    const rows = computeAgentRows(s, null, NOW);
    const codex = rows.find((r) => r.key === "codex")!;
    expect(codex.wrapped).toBe(false);
    expect(codex.health).toBe("not_wrapped");
    expect(codex.summary).toBe("not wrapped");
    expect(codex.lastSeenAt).toBeNull();
  });

  it("still says not_wrapped for a de-registered harness the daemon once saw", () => {
    const s = state({
      host: host({ harnesses: [] }),
      daemon: {
        uptime_s: 1,
        agents: [agent({ last_seen_at: "2026-09-15T11:50:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("not_wrapped");
    expect(cc.summary).toBe("not wrapped · last seen 10m ago");
  });

  it("lists every harness even with no machine enrollment at all", () => {
    const s = state({ host: null, daemon: null });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.map((r) => r.key)).toEqual(["claude-code", "codex", "stella"]);
    expect(rows.every((r) => !r.wrapped)).toBe(true);
  });
});

describe("computeAgentRows: collector down", () => {
  it("marks every wrapped harness down when the daemon does not answer", () => {
    const s = state({ daemon: null });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.wrapped).toBe(true);
    expect(cc.health).toBe("down");
    expect(cc.summary).toBe("collector not answering");
  });
});

describe("computeAgentRows: hook presence", () => {
  it("reports missing hooks, singular and plural", () => {
    const one: TachoStatus = {
      enrolled: true,
      hooks: { complete: false, present: [], missing: ["Stop"] },
    };
    const rowsOne = computeAgentRows(state(), one, NOW);
    expect(rowsOne.find((r) => r.key === "claude-code")!.health).toBe(
      "degraded",
    );
    expect(rowsOne.find((r) => r.key === "claude-code")!.summary).toBe(
      "1 hook missing",
    );

    const many: TachoStatus = {
      enrolled: true,
      hooks: { complete: false, present: [], missing: ["Stop", "PreToolUse"] },
    };
    const rowsMany = computeAgentRows(state(), many, NOW);
    expect(rowsMany.find((r) => r.key === "claude-code")!.summary).toBe(
      "2 hooks missing",
    );
    expect(rowsMany.find((r) => r.key === "claude-code")!.details).toContain(
      "hooks missing: Stop, PreToolUse",
    );
  });

  it("carries hook completeness and version into details for codex and stella", () => {
    const tacho: TachoStatus = {
      enrolled: true,
      hooks: { complete: true, present: ["Stop"], missing: [] },
      codexHooks: { complete: true, present: ["Stop"], missing: [] },
      stellaHooks: { complete: true, present: ["Stop"], missing: [] },
    };
    const s = state({
      host: host({
        harnesses: ["claude-code", "codex", "stella"],
        codex_version: "0.9.0",
        stella_version: "1.0.0",
      }),
    });
    const rows = computeAgentRows(s, tacho, NOW);
    const codex = rows.find((r) => r.key === "codex")!;
    const stella = rows.find((r) => r.key === "stella")!;
    expect(codex.details).toEqual(["Codex 0.9.0", "hooks complete"]);
    expect(stella.details).toEqual(["Stella 1.0.0", "hooks complete"]);
  });

  it("omits version and presence details when neither is known", () => {
    const rows = computeAgentRows(
      state({ host: host({ claude_version: null }) }),
      null,
      NOW,
    );
    expect(rows.find((r) => r.key === "claude-code")!.details).toEqual([]);
  });
});

describe("computeAgentRows: error and pending", () => {
  it("degrades on a standing error while the spool has not drained", () => {
    const s = state({
      daemon: { uptime_s: 1, spool_depth: 3, last_error: "ECONNREFUSED" },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("degraded");
    expect(cc.summary).toBe("Oxagen refused or unreachable: ECONNREFUSED");
  });

  it("is pending shortly after being seen with an undrained spool", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 2,
        last_ingest_at: "2026-09-15T11:00:00Z",
        agents: [agent({ last_seen_at: "2026-09-15T11:58:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("pending");
    expect(cc.summary).toBe("recorded, waiting to send");
  });

  it("degrades a pending state stuck for more than ten minutes", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 2,
        last_ingest_at: "2026-09-15T11:00:00Z",
        agents: [agent({ last_seen_at: "2026-09-15T11:40:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.find((r) => r.key === "claude-code")!.health).toBe("degraded");
  });
});

describe("computeAgentRows: healthy and idle", () => {
  it("is healthy when the last ship is at or after the last-seen time", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_ingest_at: "2026-09-15T11:59:00Z",
        agents: [agent({ last_seen_at: "2026-09-15T11:57:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("healthy");
    expect(cc.summary).toBe("last run 3m ago · delivered to Oxagen");
  });

  it("is healthy on a drained spool with no error even if last_ingest_at is stale", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_ingest_at: null,
        last_error: null,
        agents: [agent({ last_seen_at: "2026-09-15T11:57:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.find((r) => r.key === "claude-code")!.health).toBe("healthy");
  });

  it("is idle when wrapped but never seen", () => {
    const rows = computeAgentRows(state(), null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("idle");
    expect(cc.summary).toBe("wrapped · no runs recorded yet");
  });
});

describe("computeAgentRows: custom agents", () => {
  it("adds a row per custom agent and per unrecognized runtime, skipping known harnesses", () => {
    const s = state({
      host: host({ harnesses: ["claude-code"] }),
      daemon: {
        uptime_s: 1,
        // No spool_depth reported at all: the "?? 0" fallback, not the "0"
        // spool_depth explicitly seen elsewhere.
        last_ingest_at: "2026-09-15T11:59:00Z",
        agents: [
          agent({ last_seen_at: "2026-09-15T11:57:00Z" }),
          agent({
            key: "my-script",
            runtime: "custom",
            harness: "my-script",
            label: "My script",
            last_seen_at: "2026-09-15T11:55:00Z",
            sessions_total: 1,
            sessions_live: 1,
          }),
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.map((r) => r.key)).toEqual([
      "claude-code",
      "codex",
      "stella",
      "my-script",
    ]);
    const custom = rows.find((r) => r.key === "my-script")!;
    expect(custom.kind).toBe("custom");
    expect(custom.wrapped).toBe(true);
    expect(custom.details).toEqual(["reports through tacho hook"]);
    expect(custom.sessionsLive).toBe(1);
    expect(custom.health).toBe("healthy");
  });

  it("lists a custom agent quiet for a week as idle, not degraded or down", () => {
    const weekAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_error: null,
        agents: [
          agent({
            key: "old-script",
            runtime: "custom",
            harness: "old-script",
            label: "Old script",
            last_seen_at: weekAgo,
          }),
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const old = rows.find((r) => r.key === "old-script")!;
    expect(old.health).toBe("idle");
    expect(old.summary).toBe("last run 8d ago");
  });

  it("keeps a custom agent named after a built-in harness separate from it", () => {
    // tacho hook --agent codex: runtime "custom", harness "codex". Matching
    // on harness instead of runtime would fold this into the built-in
    // Codex row and hide it entirely.
    const s = state({
      host: host({ harnesses: ["claude-code"] }),
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_ingest_at: "2026-09-15T11:59:00Z",
        agents: [
          agent({
            key: "custom:codex",
            runtime: "custom",
            harness: "codex",
            label: "codex (custom script)",
            last_seen_at: "2026-09-15T11:57:00Z",
            sessions_total: 2,
            sessions_live: 0,
          }),
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.map((r) => r.key)).toEqual([
      "claude-code",
      "codex",
      "stella",
      "custom:codex",
    ]);
    const builtinCodex = rows.find((r) => r.key === "codex")!;
    expect(builtinCodex.kind).toBe("harness");
    expect(builtinCodex.wrapped).toBe(false);
    expect(builtinCodex.health).toBe("not_wrapped");
    expect(builtinCodex.lastSeenAt).toBeNull();
    const customCodex = rows.find((r) => r.key === "custom:codex")!;
    expect(customCodex.kind).toBe("custom");
    expect(customCodex.label).toBe("codex (custom script)");
    expect(customCodex.health).toBe("healthy");
  });

  it("degrades a custom row too when the shared collector has a standing error", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 4,
        last_error: "ECONNREFUSED",
        agents: [
          agent({
            key: "my-script",
            runtime: "custom",
            harness: "my-script",
            label: "My script",
            last_seen_at: "2026-09-15T11:55:00Z",
          }),
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const custom = rows.find((r) => r.key === "my-script")!;
    expect(custom.health).toBe("degraded");
    expect(custom.summary).toBe("Oxagen refused or unreachable: ECONNREFUSED");
  });

  it("produces no custom rows when the daemon has none", () => {
    const rows = computeAgentRows(state(), null, NOW);
    expect(rows.every((r) => r.kind === "harness")).toBe(true);
  });
});

describe("summarizeAgents", () => {
  it("says nothing is wrapped yet when no row is wrapped", () => {
    const rows = computeAgentRows(
      state({ host: null, daemon: null }),
      null,
      NOW,
    );
    expect(summarizeAgents(rows)).toBe("no agents wrapped yet");
  });

  it("counts each health bucket present, in a fixed order, singular for one", () => {
    const s = state({
      host: host({ harnesses: ["claude-code", "codex", "stella"] }),
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_ingest_at: "2026-09-15T11:59:00Z",
        agents: [
          agent({ last_seen_at: "2026-09-15T11:57:00Z" }), // claude-code: healthy
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    // codex and stella wrapped but never seen: idle. claude-code: healthy.
    expect(summarizeAgents(rows)).toBe("3 agents wrapped · 1 healthy · 2 idle");
  });

  it("uses singular phrasing for exactly one wrapped agent", () => {
    const rows = computeAgentRows(
      state({ host: host({ harnesses: ["claude-code"] }) }),
      null,
      NOW,
    );
    expect(summarizeAgents(rows)).toBe("1 agent wrapped · 1 idle");
  });

  it("every health label is a non-empty accessible string", () => {
    for (const label of Object.values(HEALTH_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
