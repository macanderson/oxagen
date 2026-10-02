// secrets.ts: a secret or personal data in any file a person writes.
import { classifySteeringRepoPath, type SteeringRepoFileKind } from "@oxagen/oxagen/steering-repo";
import type { TreeCheck } from "../finding";
import { finder } from "../finding";
import { findSecretsAndPii } from "../secrets";
import type { Finding } from "../types";

const find = finder("secrets");

/**
 * The kinds only Oxagen writes. The owned check refuses a hand edit to them,
 * and a lock can quote a vendor's own contact address from its API description.
 */
const OXAGEN_WRITES: ReadonlySet<SteeringRepoFileKind> = new Set<SteeringRepoFileKind>([
  "ledger",
  "server-lock",
  "cedar-schema",
]);

const CREDENTIAL_FIX =
  "Remove the value, rotate it, and store it in the Oxagen vault. Refer to it as oxagen:credential/<name>.";
const PERSONAL_FIX = "Remove the personal data. Name the role, such as the billing lead, instead of the person.";

const PERSONAL: Readonly<Record<string, string>> = {
  "email address": "an email address",
  "US social security number": "a US social security number",
  "payment card number": "a payment card number",
};

interface Described {
  rule: "credential" | "personal-data";
  message: string;
  expected: string;
  fix: string;
}

/** What one scanner label means for the person who fixes it. */
function describe(label: string): Described {
  if (label === "private key block") {
    return {
      rule: "credential",
      message: "The file holds a private key block.",
      expected: "No private key in the repository.",
      fix: CREDENTIAL_FIX,
    };
  }
  if (label === "credential token") {
    return {
      rule: "credential",
      message: "The file holds a token that looks like a credential.",
      expected: "No credential in the repository.",
      fix: CREDENTIAL_FIX,
    };
  }
  const keyed = /^value after sensitive key (.+)$/.exec(label);
  if (keyed) {
    return {
      rule: "credential",
      message: `The file sets ${keyed[1] as string} to a value that looks like a secret.`,
      expected: "No credential in the repository.",
      fix: CREDENTIAL_FIX,
    };
  }
  return {
    rule: "personal-data",
    message: `The file holds what looks like ${PERSONAL[label] ?? label}.`,
    expected: "No personal data in the repository.",
    fix: PERSONAL_FIX,
  };
}

export const secretsCheck: TreeCheck = (tree) => {
  const findings: Finding[] = [];
  for (const [path, text] of tree) {
    if (OXAGEN_WRITES.has(classifySteeringRepoPath(path))) continue;
    const labels = [...new Set(findSecretsAndPii(text))];
    if (labels.length === 0) continue;
    const lines = text.split("\n");
    for (const label of labels) {
      const index = lines.findIndex((line) => findSecretsAndPii(line).includes(label));
      findings.push(
        find({ ...describe(label), path, line: index < 0 ? null : index + 1, field: null }),
      );
    }
  }
  return findings;
};
