// @vitest-environment jsdom
// ReadFailure (read-failure.tsx): the sentence a section draws when its read
// was refused or failed, checked with axe.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Read } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { ReadFailure } from "./read-failure";

type Failure = Exclude<Read<unknown>, { ok: true }>;

function show(read: Failure) {
  render(
    <IntlProvider>
      <ReadFailure read={read} section="Runs" />
    </IntlProvider>,
  );
  return screen.getByText(/Runs/);
}

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("ReadFailure", () => {
  it("names the permission a refused read needed", () => {
    const text = show({
      ok: false,
      reason: "denied",
      permission: "runs.read",
    });
    expect(text).toHaveTextContent(
      "You cannot see Runs in this workspace. Your roles do not include runs.read",
    );
  });

  // #4370 review: a decision rule refused a person who held the role, and the
  // panel told them to ask an owner for a grant they already had.
  it("names the decision rule, not a missing role, when a rule refused the read (negative)", () => {
    const text = show({
      ok: false,
      reason: "denied",
      permission: "runs.read",
      decidedBy: { source: "decision_rule", id: "rule_require_approval_all" },
    });
    expect(text).toHaveTextContent(
      "The decision rule rule_require_approval_all refused this read.",
    );
    expect(text).not.toHaveTextContent("Your roles do not include");
  });

  it("keeps the role sentence when an IAM rule refused the read", () => {
    const text = show({
      ok: false,
      reason: "denied",
      permission: "runs.read",
      decidedBy: { source: "iam", id: "8:default" },
    });
    expect(text).toHaveTextContent("Your roles do not include runs.read");
  });
});
