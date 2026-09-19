/**
 * `tacho detect`: which AI apps this machine has, and which of them Oxagen
 * already covers. The desktop first run calls it before asking the operator
 * what to connect.
 *
 * Two kinds of app, and they are found two different ways (ADR-078):
 *
 *   - a **wrapped** harness is a CLI, found on PATH. `sh -lc` lookup means a
 *     login-shell PATH (Homebrew, nvm, `~/.local/bin`) is honoured even when
 *     the app was launched from Finder with the bare system PATH.
 *   - a **connected** app is a GUI bundle, found on disk. It answers no
 *     `--version` and is on nobody's PATH, so there is no version to report
 *     and asking for one would be a fact collected because it was available.
 *
 * Each entry carries its tier, because the caller has to say what covering
 * that app would and would not record, and a list that leaves the tier to be
 * inferred invites the surface to guess.
 */
import { readHostFile } from "../host/host-file";
import {
  isConnectedHarness,
  TACHO_HARNESS_LABELS,
  TACHO_HARNESS_TIERS,
  TACHO_TIER_SUMMARY,
  type TachoHarness,
} from "../wire";
import type { AppFacts, CliDeps, HarnessFacts } from "./deps";

export interface DetectedHarness {
  harness: TachoHarness;
  label: string;
  installed: boolean;
  path?: string;
  version?: string;
  /** Present in `host.json`'s harness list (hooks or an MCP entry written). */
  enrolled: boolean;
  /** `harness` for a wrapped app, `gateway` for a connected one. */
  tier: "harness" | "gateway";
  /** One line on what this tier records and what it does not. */
  tierSummary: string;
  /**
   * Set when this platform has no build of the app, so it cannot be covered
   * here however the operator feels about it. Claude Desktop on Linux is the
   * case that exists today.
   */
  unavailableReason?: string;
}

export interface DetectReport {
  enrolled: boolean;
  harnesses: DetectedHarness[];
}

function base(
  harness: TachoHarness,
  enrolledList: readonly string[],
): Pick<
  DetectedHarness,
  "harness" | "label" | "enrolled" | "tier" | "tierSummary"
> {
  const tier = TACHO_HARNESS_TIERS[harness];
  return {
    harness,
    label: TACHO_HARNESS_LABELS[harness],
    enrolled: enrolledList.includes(harness),
    tier,
    tierSummary: TACHO_TIER_SUMMARY[tier],
  };
}

function wrapped(
  harness: TachoHarness,
  facts: HarnessFacts,
  enrolledList: readonly string[],
): DetectedHarness {
  return {
    ...base(harness, enrolledList),
    installed: facts.path !== undefined,
    ...(facts.path !== undefined ? { path: facts.path } : {}),
    ...(facts.version !== undefined ? { version: facts.version } : {}),
  };
}

function connected(
  harness: TachoHarness,
  facts: AppFacts,
  enrolledList: readonly string[],
  unavailableReason: string | undefined,
): DetectedHarness {
  return {
    ...base(harness, enrolledList),
    installed: unavailableReason === undefined && facts.installed,
    ...(facts.path !== undefined ? { path: facts.path } : {}),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

export function detect(
  options: { json?: boolean },
  deps: CliDeps,
): DetectReport {
  const host = readHostFile(deps.paths.hostFile);
  const enrolledList = host?.revoked_at === null ? host.harnesses : [];
  const report: DetectReport = {
    enrolled: host !== undefined && host.revoked_at === null,
    harnesses: [
      wrapped("claude-code", deps.claude(), enrolledList),
      wrapped("codex", deps.codex(), enrolledList),
      wrapped("cursor", deps.cursor(), enrolledList),
      wrapped("stella", deps.stella(), enrolledList),
      connected(
        "claude-desktop",
        deps.claudeDesktop(),
        enrolledList,
        deps.paths.claudeDesktopConfig === undefined
          ? "Anthropic ships no Claude Desktop build for this platform"
          : undefined,
      ),
    ],
  };
  if (options.json === true) {
    deps.out(JSON.stringify(report, null, 2));
    return report;
  }
  for (const h of report.harnesses) {
    const state =
      h.unavailableReason !== undefined
        ? h.unavailableReason
        : h.installed
          ? isConnectedHarness(h.harness)
            ? `installed at ${h.path}`
            : `${h.version ?? "?"} at ${h.path}`
          : "not installed";
    deps.out(
      `${h.label.padEnd(16)} ${state}${h.enrolled ? " · covered" : ""}${
        h.installed
          ? ` · ${h.tier === "harness" ? "wrapped" : "connected"}`
          : ""
      }`,
    );
  }
  return report;
}
