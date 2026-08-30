import { describe, it, expect } from "vitest";
import { emailVerificationTemplate } from "./email-verification-template";

const BASE_INPUT = {
  verificationUrl: "https://app.oxagen.sh/verify-email?token=abc123",
  email: "user@example.com",
};

describe("emailVerificationTemplate", () => {
  describe("subject", () => {
    it("mentions verify", () => {
      const { subject } = emailVerificationTemplate(BASE_INPUT);
      expect(subject).toMatch(/verify/i);
    });
  });

  describe("text", () => {
    it("contains the verification URL verbatim", () => {
      const { text } = emailVerificationTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.verificationUrl);
    });

    it("contains the user email address", () => {
      const { text } = emailVerificationTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.email);
    });

    it("mentions 1 hour expiry", () => {
      const { text } = emailVerificationTemplate(BASE_INPUT);
      expect(text).toMatch(/1 hour/i);
    });

    it("informs user to ignore if they did not create an account", () => {
      const { text } = emailVerificationTemplate(BASE_INPUT);
      expect(text).toMatch(/did not create/i);
    });
  });

  describe("html", () => {
    it("contains an anchor with the verification URL as href", () => {
      const { html } = emailVerificationTemplate(BASE_INPUT);
      expect(html).toContain(`href="${BASE_INPUT.verificationUrl}"`);
    });

    it("contains the email address in the body", () => {
      const { html } = emailVerificationTemplate(BASE_INPUT);
      expect(html).toContain(BASE_INPUT.email);
    });

    it("contains a Verify email CTA label", () => {
      const { html } = emailVerificationTemplate(BASE_INPUT);
      expect(html).toMatch(/Verify email/);
    });

    it("mentions 1 hour expiry", () => {
      const { html } = emailVerificationTemplate(BASE_INPUT);
      expect(html).toMatch(/1 hour/i);
    });

    it("uses the branded CTA button style", () => {
      const { html } = emailVerificationTemplate(BASE_INPUT);
      expect(html).toContain("background:#6366f1");
      expect(html).toContain("color:#ffffff");
    });
  });

  describe("HTML escaping via esc()", () => {
    const dangerous = {
      verificationUrl: "https://example.com/verify?a=1&b=2",
      email: 'test+"<script>@example.com',
    };

    it("escapes & in verificationUrl (href) as &amp;", () => {
      const { html } = emailVerificationTemplate(dangerous);
      expect(html).toContain('href="https://example.com/verify?a=1&amp;b=2"');
    });

    it("escapes < in email as &lt;", () => {
      const { html } = emailVerificationTemplate(dangerous);
      expect(html).not.toContain("<script>");
    });

    it('escapes " in email as &quot;', () => {
      const { html } = emailVerificationTemplate(dangerous);
      expect(html).toContain("&quot;");
    });

    it("does NOT escape plain text (text carries raw values)", () => {
      const { text } = emailVerificationTemplate(dangerous);
      expect(text).toContain(dangerous.verificationUrl);
      expect(text).toContain(dangerous.email);
    });
  });
});
