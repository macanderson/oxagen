/**
 * The guard for a verdict that could only ever say one thing.
 *
 * `infra.yml` reads `tofu plan -detailed-exitcode` to label its plan comment
 * "changes" or "no changes". `setup-opentofu` wraps the binary by default, and
 * the wrapper returns 0 for the exit code 2 that means "changes present" — so
 * every infra pull request was summarised as changing nothing, including ones
 * whose plan moved a production volume.
 */
import { describe, expect, it } from "vitest";
import {
  planAsksForDetailedExitcode,
  setupSteps,
  wrapperDisabled,
} from "./check-infra-plan-verdict.mjs";

/** What shipped before the fix: the wrapper left on, in both jobs. */
const WRAPPED = `jobs:
  plan:
    steps:
      - uses: actions/checkout@v4

      - uses: opentofu/setup-opentofu@abc # v1.0.5
        with:
          tofu_version: 1.8.5

      - name: plan
        run: |
          tofu plan -input=false -no-color -detailed-exitcode -out=tf.plan > plan.txt 2>&1
  apply:
    steps:
      - uses: opentofu/setup-opentofu@abc # v1.0.5
        with:
          tofu_version: 1.8.5

      - name: apply
        run: tofu apply -auto-approve
`;

const UNWRAPPED = WRAPPED.replaceAll(
  "          tofu_version: 1.8.5\n",
  "          tofu_version: 1.8.5\n          tofu_wrapper: false\n",
);

describe("setupSteps", () => {
  it("finds every setup-opentofu step", () => {
    expect(setupSteps(WRAPPED)).toHaveLength(2);
  });

  it("stops each step at the next list item", () => {
    // A step body that ran on into the next step would read a neighbour's
    // `tofu_wrapper: false` and clear a step that never set it.
    const [first] = setupSteps(UNWRAPPED);
    expect(first).toContain("tofu_wrapper: false");
    expect(first).not.toContain("name: plan");
  });

  it("stops a step at an outdented key", () => {
    const [only] = setupSteps(`jobs:
  plan:
    steps:
      - uses: opentofu/setup-opentofu@abc
        with:
          tofu_version: 1.8.5
    outputs:
      tofu_wrapper: false
`);
    expect(wrapperDisabled(only)).toBe(false);
  });

  it("finds nothing when the action is not used", () => {
    expect(
      setupSteps(
        "jobs:\n  plan:\n    steps:\n      - uses: actions/checkout@v4\n",
      ),
    ).toEqual([]);
  });
});

describe("wrapperDisabled", () => {
  it("rejects a step that leaves the wrapper on", () => {
    // The witness: this is what shipped.
    expect(setupSteps(WRAPPED).every(wrapperDisabled)).toBe(false);
  });

  it("accepts steps that turn it off", () => {
    expect(setupSteps(UNWRAPPED).every(wrapperDisabled)).toBe(true);
  });

  it("does not accept the wrapper being switched back on", () => {
    expect(wrapperDisabled("  tofu_wrapper: true\n")).toBe(false);
  });
});

describe("planAsksForDetailedExitcode", () => {
  it("sees the flag on the plan invocation", () => {
    expect(planAsksForDetailedExitcode(WRAPPED)).toBe(true);
  });

  it("is false when the flag is dropped", () => {
    // Without it tofu exits 0 either way, which pins the verdict just as hard
    // as the wrapper did.
    expect(
      planAsksForDetailedExitcode(WRAPPED.replace(" -detailed-exitcode", "")),
    ).toBe(false);
  });

  it("does not count the flag appearing on some other command", () => {
    expect(planAsksForDetailedExitcode("run: echo -detailed-exitcode\n")).toBe(
      false,
    );
  });
});
