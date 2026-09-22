// @vitest-environment jsdom
// Every refusal a single sign-on write can meet has its own sentence: each
// field the actions check, each reason the org.sso.* handlers throw, and the
// kernel's own classifications. An unknown code is printed as recorded.
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IntlProvider } from "@/test/intl";
import { SSO_UNANSWERED, useSsoFailure, type SsoFailure } from "./sso-failure";

const intl = ({ children }: { children: ReactNode }) => (
  <IntlProvider>{children}</IntlProvider>
);

function sentence(failure: SsoFailure): string {
  const { result } = renderHook(() => useSsoFailure(), { wrapper: intl });
  return result.current(failure);
}

const invalid = (code: string, field?: string): SsoFailure => ({
  ok: false,
  reason: "invalid",
  code,
  ...(field === undefined ? {} : { field }),
});

describe("useSsoFailure", () => {
  it("names a refusal by role", () => {
    expect(sentence({ ok: false, reason: "denied", code: "forbidden" })).toBe(
      "Only an Owner or an Admin can change single sign-on.",
    );
  });

  it.each([
    ["provider_id_required", "Enter a provider ID."],
    ["display_name_required", "Enter a display name."],
    ["domain_required", "Enter an email domain."],
    ["issuer_required", "Enter the issuer."],
    ["client_id_required", "Enter the client ID."],
    ["client_secret_required", "Enter the client secret."],
    ["entry_point_required", "Enter the SSO URL."],
    ["cert_required", "Paste the signing certificate."],
    [
      "cert_required_for_change",
      "Paste the signing certificate to save a change to the SAML settings.",
    ],
    ["group_required", "Enter a group name."],
    [
      "group_duplicate",
      "This group already has a row. Give each group one role.",
    ],
  ])("names the missing field for %s", (code, text) => {
    expect(sentence(invalid(code))).toBe(text);
  });

  it("names a field's format when the contract refused one field", () => {
    expect(sentence(invalid("invalid_input", "domain"))).toBe(
      "Check this value and try again.",
    );
  });

  it("names the settings as a whole when the contract named no field", () => {
    expect(sentence(invalid("invalid_input"))).toMatch(
      /could not use these settings/,
    );
    expect(sentence(invalid("invalid_input", ""))).toMatch(
      /could not use these settings/,
    );
  });

  it.each([
    ["conflict", "dns_record_not_found", /TXT record was not found/],
    ["conflict", "no_verified_provider", /Verify a provider's domain/],
    ["conflict", "provider_id_taken", /already exists/],
    ["conflict", "provider_id_reserved", /belongs to another sign-in method/],
    ["conflict", "domain_taken", /already uses this email domain/],
    ["not_found", "sso_provider_not_found", /no longer exists/],
    ["conflict", "something_new", /refused the change \(something_new\)/],
  ] as const)("names the %s reason %s", (reason, code, text) => {
    expect(sentence({ ok: false, reason, code })).toMatch(text);
  });

  it("says a change is waiting for approval", () => {
    expect(
      sentence({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "ar_1",
      }),
    ).toBe("The change is waiting for approval.");
  });

  it("prints the code of an unavailable or exhausted write", () => {
    expect(sentence(SSO_UNANSWERED)).toBe(
      "The change could not be saved (action_failed). Try again.",
    );
    expect(
      sentence({ ok: false, reason: "exhausted", code: "budget_exceeded" }),
    ).toMatch(/budget_exceeded/);
  });
});
