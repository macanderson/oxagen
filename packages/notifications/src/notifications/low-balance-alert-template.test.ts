import { describe, it, expect } from "vitest";
import { lowBalanceAlertTemplate } from "./low-balance-alert-template";

const BASE_INPUT = {
  orgName: "Acme Corp",
  balanceCents: 1050,
  thresholdCents: 2000,
  topUpUrl: "https://app.oxagen.sh/billing/top-up",
};

describe("lowBalanceAlertTemplate", () => {
  describe("subject", () => {
    it("contains the org name", () => {
      const { subject } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(subject).toContain(BASE_INPUT.orgName);
    });

    it("mentions low balance", () => {
      const { subject } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(subject).toMatch(/low balance/i);
    });
  });

  describe("text", () => {
    it("contains the top-up URL verbatim", () => {
      const { text } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.topUpUrl);
    });

    it("contains the org name", () => {
      const { text } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.orgName);
    });

    it("contains the balance formatted as dollars", () => {
      const { text } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(text).toContain("$10.50");
    });

    it("contains the threshold formatted as dollars", () => {
      const { text } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(text).toContain("$20.00");
    });
  });

  describe("html", () => {
    it("contains an anchor with the top-up URL as href", () => {
      const { html } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(html).toContain(`href="${BASE_INPUT.topUpUrl}"`);
    });

    it("contains the org name", () => {
      const { html } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(html).toContain(BASE_INPUT.orgName);
    });

    it("contains dollar-formatted balance", () => {
      const { html } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(html).toContain("$10.50");
    });

    it("contains dollar-formatted threshold", () => {
      const { html } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(html).toContain("$20.00");
    });

    it("contains an Add credits CTA label", () => {
      const { html } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(html).toMatch(/Add credits/);
    });

    it("uses the branded CTA button style", () => {
      const { html } = lowBalanceAlertTemplate(BASE_INPUT);
      expect(html).toContain("background:#6366f1");
      expect(html).toContain("color:#ffffff");
    });
  });

  describe("HTML escaping via esc()", () => {
    const dangerous = {
      orgName: 'Org & "Friends" <script>',
      balanceCents: 500,
      thresholdCents: 1000,
      topUpUrl: "https://example.com/top-up?a=1&b=2",
    };

    it("escapes & in topUpUrl (href) as &amp;", () => {
      const { html } = lowBalanceAlertTemplate(dangerous);
      expect(html).toContain('href="https://example.com/top-up?a=1&amp;b=2"');
    });

    it("escapes < in orgName as &lt;", () => {
      const { html } = lowBalanceAlertTemplate(dangerous);
      expect(html).not.toContain("<script>");
    });

    it("escapes & and quotes in orgName", () => {
      const { html } = lowBalanceAlertTemplate(dangerous);
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;");
    });

    it("does NOT escape plain text (text carries raw values)", () => {
      const { text } = lowBalanceAlertTemplate(dangerous);
      expect(text).toContain(dangerous.topUpUrl);
      expect(text).toContain(dangerous.orgName);
    });
  });
});
