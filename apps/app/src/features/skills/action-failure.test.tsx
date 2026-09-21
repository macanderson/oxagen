// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import messages from "../../../messages/skills.json";
import { UNANSWERED, useSkillFailure } from "./action-failure";

describe("skill action refusal", () => {
  it("names role, approval, input and remote failure without discarding drafts", () => {
    const { result } = renderHook(useSkillFailure, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
      ),
    });
    expect(
      result.current({ ok: false, reason: "denied", code: "forbidden" }),
    ).toContain("owner or admin");
    expect(
      result.current({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_123",
      }),
    ).toContain("acr_123");
    expect(
      result.current({ ok: false, reason: "invalid", code: "invalid" }),
    ).toContain("Check the configuration");
    expect(result.current(UNANSWERED)).toContain("action_failed");
  });
});
