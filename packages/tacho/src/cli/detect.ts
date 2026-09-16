/**
 * `tacho detect`: which harnesses this machine has, and which of them are
 * already hooked. The desktop wizard runs it before asking the operator
 * what to register; `sh -lc` lookup means a login-shell PATH (Homebrew,
 * nvm, ~/.local/bin) is honoured even when the app itself was launched
 * from Finder with the bare system PATH.
 */
import { readHostFile } from "../host/host-file";
import { TACHO_HARNESS_LABELS, type TachoHarness } from "../wire";
import type { CliDeps, HarnessFacts } from "./deps";

export interface DetectedHarness {
  harness: TachoHarness;
  label: string;
  installed: boolean;
  path?: string;
  version?: string;
  /** Present in `host.json`'s harness list (hooks written for it). */
  enrolled: boolean;
}

export interface DetectReport {
  enrolled: boolean;
  harnesses: DetectedHarness[];
}

function entry(
  harness: TachoHarness,
  facts: HarnessFacts,
  enrolledList: readonly string[],
): DetectedHarness {
  return {
    harness,
    label: TACHO_HARNESS_LABELS[harness],
    installed: facts.path !== undefined,
    ...(facts.path !== undefined ? { path: facts.path } : {}),
    ...(facts.version !== undefined ? { version: facts.version } : {}),
    enrolled: enrolledList.includes(harness),
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
      entry("claude-code", deps.claude(), enrolledList),
      entry("codex", deps.codex(), enrolledList),
      entry("stella", deps.stella(), enrolledList),
    ],
  };
  if (options.json === true) {
    deps.out(JSON.stringify(report, null, 2));
    return report;
  }
  for (const h of report.harnesses) {
    deps.out(
      `${h.label.padEnd(12)} ${h.installed ? `${h.version ?? "?"} at ${h.path}` : "not installed"}${h.enrolled ? " · enrolled" : ""}`,
    );
  }
  return report;
}
