import { describe, it, expect } from "vitest";
import { invitationEmailTemplate } from "./invitation-email-template";

const BASE_INPUT = {
  inviteUrl: "https://app.oxagen.sh/invite?token=invite123",
  inviterName: "Jane Smith",
  orgName: "Acme Corp",
  role: "member",
  email: "newuser@example.com",
};

describe("invitationEmailTemplate", () => {
  describe("subject", () => {
    it("contains the org name", () => {
      const { subject } = invitationEmailTemplate(BASE_INPUT);
      expect(subject).toContain(BASE_INPUT.orgName);
    });

    it("mentions invited", () => {
      const { subject } = invitationEmailTemplate(BASE_INPUT);
      expect(subject).toMatch(/invited/i);
    });
  });

  describe("text", () => {
    it("contains the invite URL verbatim", () => {
      const { text } = invitationEmailTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.inviteUrl);
    });

    it("contains the inviter name", () => {
      const { text } = invitationEmailTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.inviterName);
    });

    it("contains the org name", () => {
      const { text } = invitationEmailTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.orgName);
    });

    it("contains the role", () => {
      const { text } = invitationEmailTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.role);
    });

    it("contains the email address", () => {
      const { text } = invitationEmailTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.email);
    });

    it("mentions 7 days expiry", () => {
      const { text } = invitationEmailTemplate(BASE_INPUT);
      expect(text).toMatch(/7 days/i);
    });
  });

  describe("html", () => {
    it("contains an anchor with the invite URL as href", () => {
      const { html } = invitationEmailTemplate(BASE_INPUT);
      expect(html).toContain(`href="${BASE_INPUT.inviteUrl}"`);
    });

    it("contains the inviter name", () => {
      const { html } = invitationEmailTemplate(BASE_INPUT);
      expect(html).toContain(BASE_INPUT.inviterName);
    });

    it("contains the org name", () => {
      const { html } = invitationEmailTemplate(BASE_INPUT);
      expect(html).toContain(BASE_INPUT.orgName);
    });

    it("contains an Accept invitation CTA label", () => {
      const { html } = invitationEmailTemplate(BASE_INPUT);
      expect(html).toMatch(/Accept invitation/);
    });

    it("mentions 7 days expiry", () => {
      const { html } = invitationEmailTemplate(BASE_INPUT);
      expect(html).toMatch(/7 days/i);
    });

    it("uses the branded CTA button style", () => {
      const { html } = invitationEmailTemplate(BASE_INPUT);
      expect(html).toContain("background:#6366f1");
      expect(html).toContain("color:#ffffff");
    });
  });

  describe("HTML escaping via esc()", () => {
    const dangerous = {
      inviteUrl: "https://example.com/invite?a=1&b=2",
      inviterName: '<script>alert("xss")</script>',
      orgName: 'Org & "Friends"',
      role: "admin",
      email: "test@example.com",
    };

    it("escapes & in inviteUrl (href) as &amp;", () => {
      const { html } = invitationEmailTemplate(dangerous);
      expect(html).toContain('href="https://example.com/invite?a=1&amp;b=2"');
    });

    it("escapes < in inviterName as &lt;", () => {
      const { html } = invitationEmailTemplate(dangerous);
      expect(html).not.toContain("<script>");
    });

    it("escapes & and quotes in orgName", () => {
      const { html } = invitationEmailTemplate(dangerous);
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;");
    });

    it("does NOT escape plain text (text carries raw values)", () => {
      const { text } = invitationEmailTemplate(dangerous);
      expect(text).toContain(dangerous.inviteUrl);
      expect(text).toContain(dangerous.inviterName);
      expect(text).toContain(dangerous.orgName);
    });
  });
});
