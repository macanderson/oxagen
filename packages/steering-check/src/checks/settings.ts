// settings.ts: the repository settings differ from the ones Oxagen
// prescribes. Lane S2 reads the host and passes the differences in as the
// repository's health, so this check reads no file.
import { REQUIRED_CHECK_NAME } from "@oxagen/oxagen/steering-repo";
import type { ChangeCheck } from "../finding";
import { finder } from "../finding";
import type { Finding, SettingsDifferenceInput } from "../types";

const find = finder("settings");

const REPAIR =
  "A workspace admin opens Workspace settings, then Steering repo, and selects Repair settings.";

/** A value as the message prints it: JSON, cut at 120 characters. */
function shown(value: unknown): string {
  const text = value === undefined || value === null ? "unset" : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

interface Described {
  rule: string;
  message: string;
  fix: string;
}

function describe(difference: SettingsDifferenceInput): Described {
  const { setting, actual } = difference;
  const parts = setting.split(".");
  if (setting === "merge_requests.required_status") {
    return {
      rule: "required-check-removed",
      message: `Merge requests no longer require the status "${REQUIRED_CHECK_NAME}"`,
      fix: `${REPAIR} Or set the required status back to "${REQUIRED_CHECK_NAME}" by hand.`,
    };
  }
  if (setting === "actions.enabled" && actual === true) {
    return {
      rule: "actions-enabled",
      message: "GitHub Actions is on",
      fix: `${REPAIR} Or turn Actions off by hand. Oxagen runs every check itself.`,
    };
  }
  if (setting === "ci_cd.builds_access_level" && actual !== "disabled") {
    return {
      rule: "ci-enabled",
      message: "CI/CD is on",
      fix: `${REPAIR} Or turn CI/CD off by hand. Oxagen runs every check itself.`,
    };
  }
  if (parts[0] === "protected_branches" && parts[2] === "allow_force_push" && actual === true) {
    return {
      rule: "force-push-allowed",
      message: `The protected branch ${parts[1] as string} allows force pushes`,
      fix: `${REPAIR} Or turn force pushes off by hand.`,
    };
  }
  return {
    rule: "setting-differs",
    message: `${setting} is ${shown(actual)}`,
    fix: `${REPAIR} Or set it back by hand.`,
  };
}

/** When and by whom, as the host reports it. */
function changedBy(difference: SettingsDifferenceInput): string {
  const at = difference.changed_at ? difference.changed_at : null;
  const by = difference.changed_by ? `@${difference.changed_by}` : null;
  if (at && by) return ` (${at}, by ${by})`;
  if (at) return ` (${at})`;
  if (by) return ` (by ${by})`;
  return "";
}

export const settingsCheck: ChangeCheck = (env) => {
  if (env.health === null) {
    return { findings: [], skipped: "no repository settings were passed in, as when the check runs on a laptop" };
  }
  const findings: Finding[] = env.health.differences.map((difference) => {
    const { rule, message, fix } = describe(difference);
    return find({
      rule,
      path: difference.setting,
      line: null,
      field: null,
      message: `${message}${changedBy(difference)}.`,
      expected: `${difference.setting} is ${shown(difference.expected)}.`,
      fix,
    });
  });
  return findings.length === 0
    ? { findings }
    : { findings, note: "Repository settings changed. Oxagen will not merge or publish until they match." };
};
