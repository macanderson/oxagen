// settings-diff.ts: the prescribed settings a host's report differs from.
// Lane S2 reads the host and stores the differences as the repository's
// health. This is the comparison, so S2, the tests, and `oxagen check` agree
// on what counts as a difference.
import {
  GITHUB_SETTINGS_BASELINE,
  GITLAB_SETTINGS_BASELINE,
} from "@oxagen/oxagen/steering-repo";
import { canonicalJson as canonical, isRecord } from "./repo";
import type { SettingsDifferenceInput } from "./types";

function walk(expected: unknown, actual: unknown, path: string, out: SettingsDifferenceInput[]): void {
  if (isRecord(expected) && isRecord(actual)) {
    for (const key of Object.keys(expected)) {
      walk(expected[key], actual[key], path === "" ? key : `${path}.${key}`, out);
    }
    return;
  }
  if (canonical(expected) === canonical(actual)) return;
  out.push({ setting: path, expected, actual: actual ?? null, changed_by: null, changed_at: null });
}

/**
 * Every prescribed setting the host reports a different value for, by its
 * path in the baseline. A table descends key by key. A list is one value,
 * so a ruleset's rules differ as a whole. A setting the baseline does not
 * name is not compared.
 */
export function settingsDifferences(
  provider: "github" | "gitlab",
  actual: unknown,
): SettingsDifferenceInput[] {
  const baseline = provider === "github" ? GITHUB_SETTINGS_BASELINE : GITLAB_SETTINGS_BASELINE;
  const out: SettingsDifferenceInput[] = [];
  walk(baseline, actual, "", out);
  return out;
}
