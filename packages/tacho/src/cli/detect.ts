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
import { listSlots } from "../host/slots";
import {
  isConnectedHarness,
  TACHO_HARNESS_LABELS,
  TACHO_HARNESS_TIERS,
  TACHO_TIER_SUMMARY,
  type TachoHarness,
} from "../wire";
import type { AppFacts, CliDeps, CursorFacts, HarnessFacts } from "./deps";
import { rootPathsOf } from "./slot-deps";

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
  /**
   * Which probe answered: `cli` for an executable on PATH, `app` for an
   * application on disk. Absent when neither did. A surface that offers to
   * cover the app says which one it is acting on rather than implying a CLI
   * that is not there.
   */
  foundVia?: "cli" | "app";
  /**
   * Why enrolling this harness covers the machine whether or not a probe
   * found it, so a surface offers the row instead of disabling it and can say
   * what it is offering. Cursor is the case: `~/.cursor/hooks.json` governs
   * the editor and the CLI alike, and Cursor's Linux build is an AppImage
   * with no documented location, so "not found" there is the probe's limit
   * rather than the machine's. It is the counterpart of `unavailableReason`.
   */
  coverableWhenAbsent?: string;
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
    ...(facts.path !== undefined
      ? { path: facts.path, foundVia: "cli" as const }
      : {}),
    ...(facts.version !== undefined ? { version: facts.version } : {}),
  };
}

/**
 * What a surface tells the operator about a Cursor it could not find. The
 * hooks file is what governs Cursor, and enrollment writes it either way.
 */
export const CURSOR_COVERAGE_NOTE =
  "enrollment writes ~/.cursor/hooks.json, which governs the Cursor editor and the cursor-agent CLI alike";

/**
 * Cursor, which answers two probes rather than one. The alias on PATH is the
 * stronger signal and reports a version; the editor on disk is the only signal
 * on a machine that never installed the CLI, and that machine is wrapped all
 * the same because both read `~/.cursor/hooks.json`. Neither answering is not
 * evidence of absence, so the entry says the harness is still coverable.
 */
export function wrappedCursor(
  facts: CursorFacts,
  enrolledList: readonly string[],
): DetectedHarness {
  const cli = wrapped("cursor", facts, enrolledList);
  if (cli.installed)
    return { ...cli, coverableWhenAbsent: CURSOR_COVERAGE_NOTE };
  const app = facts.app;
  return {
    ...cli,
    coverableWhenAbsent: CURSOR_COVERAGE_NOTE,
    ...(app?.installed === true
      ? {
          installed: true,
          foundVia: "app" as const,
          ...(app.path !== undefined ? { path: app.path } : {}),
        }
      : {}),
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
  // Lenient, as `status` and `unenroll` read it: a host.json from another
  // version or cut short must not stop the first run from listing the apps.
  // Every enrollment on the machine counts (ADR-202): a harness another
  // agent hooks is covered all the same.
  const enrolledHosts = listSlots(rootPathsOf(deps)).flatMap((slot) =>
    slot.host !== undefined && slot.host.revoked_at === null ? [slot.host] : [],
  );
  const enrolledList = enrolledHosts.flatMap((host) => host.harnesses);
  const report: DetectReport = {
    enrolled: enrolledHosts.length > 0,
    harnesses: [
      wrapped("claude-code", deps.claude(), enrolledList),
      wrapped("codex", deps.codex(), enrolledList),
      wrappedCursor(deps.cursor(), enrolledList),
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
    // An app found on disk answers no `--version`, so the line says where it
    // is rather than printing a `?` for a number nothing asked it for.
    const installedState =
      isConnectedHarness(h.harness) || h.foundVia === "app"
        ? `installed at ${h.path}`
        : `${h.version ?? "?"} at ${h.path}`;
    const state =
      h.unavailableReason !== undefined
        ? h.unavailableReason
        : h.installed
          ? installedState
          : h.coverableWhenAbsent !== undefined
            ? `not found, and ${h.coverableWhenAbsent}`
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
