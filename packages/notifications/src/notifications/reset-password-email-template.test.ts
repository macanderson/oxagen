import { describe, it, expect } from "vitest";
import { resetPasswordEmailTemplate } from "./reset-password-email-template";

const BASE_INPUT = {
  resetUrl: "https://app.oxagen.sh/reset-password?token=abc123",
  email: "user@example.com",
};

describe("resetPasswordEmailTemplate", () => {
  describe("subject", () => {
    it("mentions password reset", () => {
      const { subject } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(subject).toMatch(/reset/i);
    });

    it("mentions Oxagen", () => {
      const { subject } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(subject).toContain("Oxagen");
    });
  });

  describe("text", () => {
    it("contains the reset URL verbatim", () => {
      const { text } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.resetUrl);
    });

    it("contains the user email address", () => {
      const { text } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.email);
    });

    it("mentions 1 hour expiry", () => {
      const { text } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(text).toMatch(/1 hour/i);
    });

    it("informs user to ignore if they did not request a reset", () => {
      const { text } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(text).toMatch(/did not request/i);
    });
  });

  describe("html", () => {
    it("contains an anchor with the reset URL as href", () => {
      const { html } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(html).toContain(`href="${BASE_INPUT.resetUrl}"`);
    });

    it("contains the email address in the body", () => {
      const { html } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(html).toContain(BASE_INPUT.email);
    });

    it("contains a reset-password CTA label", () => {
      const { html } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(html).toMatch(/reset password/i);
    });

    it("mentions 1 hour expiry", () => {
      const { html } = resetPasswordEmailTemplate(BASE_INPUT);
      expect(html).toMatch(/1 hour/i);
    });
  });

  describe("HTML escaping via esc()", () => {
    const dangerous = {
      resetUrl: "https://example.com/reset?a=1&b=2",
      email: 'test+"<script>@example.com',
    };

    it("escapes & in resetUrl (href) as &amp;", () => {
      const { html } = resetPasswordEmailTemplate(dangerous);
      expect(html).toContain('href="https://example.com/reset?a=1&amp;b=2"');
    });

    it("escapes < in email as &lt;", () => {
      const { html } = resetPasswordEmailTemplate(dangerous);
      expect(html).not.toContain("<script>");
    });

    it("does NOT escape plain text (text carries raw values)", () => {
      const { text } = resetPasswordEmailTemplate(dangerous);
      expect(text).toContain(dangerous.resetUrl);
    });
  });
});
