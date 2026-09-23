// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import messages from "../../../messages/organization.json";
import { useActionFailure } from "./action-failure";

function render() {
  return renderHook(useActionFailure, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        {children}
      </NextIntlClientProvider>
    ),
  }).result.current;
}

describe("Organization action refusal", () => {
  it("names a deleted identity provider rather than printing its code (ADR-145)", () => {
    const word = render();
    expect(
      word({
        ok: false,
        reason: "not_found",
        code: "sso_provider_not_found",
      }),
    ).toBe("This identity provider no longer exists. Reload the page.");
  });

  it("prints a code it has no sentence for as recorded", () => {
    const word = render();
    expect(
      word({ ok: false, reason: "conflict", code: "something_new" }),
    ).toContain("something_new");
  });
});
