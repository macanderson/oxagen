#!/usr/bin/env node
/**
 * Anything that reads `tofu plan`'s exit code must be able to hear a 2.
 *
 * Two workflows here decide something from one number: `infra.yml` labels its
 * plan comment "changes" or "no changes", and `infra-drift.yml` reports a stack
 * `clean` or `DRIFT`. `tofu plan -detailed-exitcode` returns 2 when a plan
 * contains changes and 0 when it does not. Two independent settings have to hold
 * for that number to arrive, and each one silently pins the answer to a constant
 * on its own.
 *
 * `setup-opentofu` installs a wrapper around the `tofu` binary by default, and
 * the wrapper treats 2 exactly like 0:
 *
 *     if (exitCode === 0 || exitCode === 2) { return }
 *
 * so the shell saw 0 for every plan. Every plan comment said "no changes",
 * including on pull requests whose plan moved a production EBS volume, and the
 * daily drift detector would have reported every stack clean forever — the muted
 * monitor it exists to avoid being. Without `-detailed-exitcode` the answer is a
 * constant again from the other direction, because tofu then returns 0 whether
 * or not it found changes.
 *
 * A reviewer reads that heading to decide whether merging touches production. A
 * plan that found changes must never read like a plan that found none.
 *
 * Every workflow under .github/workflows is scanned rather than the two by
 * name. `infra.yml` got the wrapper on 2026-09-04 and `infra-drift.yml` arrived
 * carrying it five days later, so a check naming its subjects would already have
 * missed the one that mattered most.
 *
 * Deliberately a string check on the workflows, like its sibling
 * check-main-concurrency: GitHub evaluates these server-side and the wrapper
 * only exists on a runner, so there is nothing to execute locally. What can be
 * held still is the shape.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_DIR = join(repoRoot, ".github", "workflows");

/**
 * Every `setup-opentofu` step, as the text of its own step block. A step ends
 * where the next list item at the same indentation begins.
 */
export function setupSteps(yaml) {
  const lines = yaml.split("\n");
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = lines[i].match(/^(\s*)- uses:\s*opentofu\/setup-opentofu/);
    if (!start) continue;
    const indent = start[1].length;
    const body = [lines[i]];
    for (let j = i + 1; j < lines.length; j += 1) {
      const isNextItem = new RegExp(`^\\s{${indent}}- `).test(lines[j]);
      const isOutdented =
        /^\s*\S/.test(lines[j]) && lines[j].search(/\S/) < indent;
      if (isNextItem || isOutdented) break;
      body.push(lines[j]);
    }
    steps.push(body.join("\n"));
  }
  return steps;
}

/** Does this step turn the exit-code-swallowing wrapper off? */
export function wrapperDisabled(step) {
  return /^\s*tofu_wrapper:\s*false\s*$/m.test(step);
}

/** Does some `tofu plan` in this workflow ask for the detailed exit code? */
export function planAsksForDetailedExitcode(yaml) {
  return yaml
    .split("\n")
    .some(
      (line) => /\btofu plan\b/.test(line) && /-detailed-exitcode\b/.test(line),
    );
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  const files = readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  const problems = [];
  let stepCount = 0;
  let usingWorkflows = 0;
  let readsExitcode = 0;

  for (const file of files) {
    const yaml = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    const steps = setupSteps(yaml);
    if (steps.length === 0) continue;
    usingWorkflows += 1;
    stepCount += steps.length;

    const wrapped = steps.filter((step) => !wrapperDisabled(step)).length;
    if (wrapped > 0) {
      problems.push(
        `${file}: ${wrapped} of ${steps.length} setup-opentofu steps do not set \`tofu_wrapper: false\`.\n` +
          "  The wrapper returns 0 for a plan that found changes, so whatever this\n" +
          "  workflow decides from that exit code can only ever reach one answer.",
      );
    }

    if (planAsksForDetailedExitcode(yaml)) {
      readsExitcode += 1;
    }
  }

  if (usingWorkflows === 0) {
    problems.push(
      "no workflow under .github/workflows uses setup-opentofu — this check reads\n" +
        "  that directory, so point it at wherever tofu runs now.",
    );
  } else if (readsExitcode === 0) {
    problems.push(
      "no `tofu plan` invocation in any workflow passes `-detailed-exitcode`.\n" +
        "  Without it tofu exits 0 whether or not it found changes, and the answer\n" +
        "  is a constant from the other direction.",
    );
  }

  if (problems.length > 0) {
    console.error(
      "check-infra-plan-verdict: a tofu plan that found changes would read like one that found none.\n\n" +
        problems.map((p) => `- ${p}`).join("\n\n") +
        "\n\nThe plan comment's heading is what a reviewer reads to decide whether\n" +
        "merging touches production, and the drift job's verdict is the only thing\n" +
        "that ever says the account stopped matching the configuration.",
    );
    process.exit(1);
  }

  console.log(
    `check-infra-plan-verdict: ${stepCount} setup-opentofu steps across ${usingWorkflows} workflows pass tofu's exit code through.`,
  );
}
