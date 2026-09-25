import { describe, it, expect } from "vitest";
import { existingAccountEmailTemplate } from "./existing-account-email-template";

const BASE_INPUT = {
  email: "owner@example.com",
  loginUrl: "https://app.oxagen.sh/login",
  forgotPasswordUrl: "https://app.oxagen.sh/forgot-password",
};

describe("existingAccountEmailTemplate", () => {
  it("says the account already exists in the subject", () => {
    const { subject } = existingAccountEmailTemplate(BASE_INPUT);
    expect(subject).toContain("Oxagen");
    expect(subject).toMatch(/already have/i);
  });

  it("puts the address, the login link, and the reset link in the text", () => {
    const { text } = existingAccountEmailTemplate(BASE_INPUT);
    expect(text).toContain(BASE_INPUT.email);
    expect(text).toContain(BASE_INPUT.loginUrl);
    expect(text).toContain(BASE_INPUT.forgotPasswordUrl);
    expect(text).toMatch(/did not try to sign up/i);
  });

  it("links both pages from the HTML body", () => {
    const { html } = existingAccountEmailTemplate(BASE_INPUT);
    expect(html).toContain(`href="${BASE_INPUT.loginUrl}"`);
    expect(html).toContain(`href="${BASE_INPUT.forgotPasswordUrl}"`);
    expect(html).toContain("Log in");
    expect(html).toContain("Reset it here");
  });

  it("escapes the address before placing it in HTML", () => {
    const { html } = existingAccountEmailTemplate({
      ...BASE_INPUT,
      email: '<script>alert("x")</script>@example.com',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("carries no em dash in either body", () => {
    const { text, html } = existingAccountEmailTemplate(BASE_INPUT);
    expect(text).not.toContain("—");
    expect(html).not.toContain("—");
  });
});
