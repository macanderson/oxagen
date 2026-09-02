import { describe, it, expect } from "vitest";
import { paymentFailedTemplate } from "./payment-failed-template";

const BASE_INPUT = {
  orgName: "Acme Corp",
  graceDays: 7,
  billingUrl: "https://app.oxagen.sh/billing/payment-methods",
};

describe("paymentFailedTemplate", () => {
  describe("subject", () => {
    it("contains the org name", () => {
      const { subject } = paymentFailedTemplate(BASE_INPUT);
      expect(subject).toContain(BASE_INPUT.orgName);
    });

    it("mentions payment failed", () => {
      const { subject } = paymentFailedTemplate(BASE_INPUT);
      expect(subject).toMatch(/payment failed/i);
    });
  });

  describe("text", () => {
    it("contains the billing URL verbatim", () => {
      const { text } = paymentFailedTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.billingUrl);
    });

    it("contains the org name", () => {
      const { text } = paymentFailedTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.orgName);
    });

    it("mentions grace period days", () => {
      const { text } = paymentFailedTemplate(BASE_INPUT);
      expect(text).toContain("7 days");
    });

    it("mentions account suspension", () => {
      const { text } = paymentFailedTemplate(BASE_INPUT);
      expect(text).toMatch(/suspended/i);
    });
  });

  describe("html", () => {
    it("contains an anchor with the billing URL as href", () => {
      const { html } = paymentFailedTemplate(BASE_INPUT);
      expect(html).toContain(`href="${BASE_INPUT.billingUrl}"`);
    });

    it("contains the org name", () => {
      const { html } = paymentFailedTemplate(BASE_INPUT);
      expect(html).toContain(BASE_INPUT.orgName);
    });

    it("mentions grace period days", () => {
      const { html } = paymentFailedTemplate(BASE_INPUT);
      expect(html).toContain("7 days");
    });

    it("contains an Update payment method CTA label", () => {
      const { html } = paymentFailedTemplate(BASE_INPUT);
      expect(html).toMatch(/Update payment method/);
    });

    it("uses the branded CTA button style", () => {
      const { html } = paymentFailedTemplate(BASE_INPUT);
      expect(html).toContain("background:#6366f1");
      expect(html).toContain("color:#ffffff");
    });
  });

  describe("HTML escaping via esc()", () => {
    const dangerous = {
      orgName: 'Org & "Friends" <script>',
      graceDays: 14,
      billingUrl: "https://example.com/billing?a=1&b=2",
    };

    it("escapes & in billingUrl (href) as &amp;", () => {
      const { html } = paymentFailedTemplate(dangerous);
      expect(html).toContain('href="https://example.com/billing?a=1&amp;b=2"');
    });

    it("escapes < in orgName as &lt;", () => {
      const { html } = paymentFailedTemplate(dangerous);
      expect(html).not.toContain("<script>");
    });

    it("escapes & and quotes in orgName", () => {
      const { html } = paymentFailedTemplate(dangerous);
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;");
    });

    it("does NOT escape plain text (text carries raw values)", () => {
      const { text } = paymentFailedTemplate(dangerous);
      expect(text).toContain(dangerous.billingUrl);
      expect(text).toContain(dangerous.orgName);
    });
  });
});
