import { describe, it, expect } from "vitest";
import { paymentReceiptTemplate } from "./payment-receipt-template";

const BASE_INPUT = {
  orgName: "Acme Corp",
  amountCents: 4999,
  description: "500 credits top-up",
  receiptUrl: "https://app.oxagen.sh/billing/receipts/r_123",
};

describe("paymentReceiptTemplate", () => {
  describe("subject", () => {
    it("contains the org name", () => {
      const { subject } = paymentReceiptTemplate(BASE_INPUT);
      expect(subject).toContain(BASE_INPUT.orgName);
    });

    it("mentions payment receipt", () => {
      const { subject } = paymentReceiptTemplate(BASE_INPUT);
      expect(subject).toMatch(/payment receipt/i);
    });
  });

  describe("text", () => {
    it("contains the receipt URL verbatim", () => {
      const { text } = paymentReceiptTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.receiptUrl);
    });

    it("contains the org name", () => {
      const { text } = paymentReceiptTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.orgName);
    });

    it("contains the amount formatted as dollars", () => {
      const { text } = paymentReceiptTemplate(BASE_INPUT);
      expect(text).toContain("$49.99");
    });

    it("contains the description", () => {
      const { text } = paymentReceiptTemplate(BASE_INPUT);
      expect(text).toContain(BASE_INPUT.description);
    });
  });

  describe("html", () => {
    it("contains an anchor with the receipt URL as href", () => {
      const { html } = paymentReceiptTemplate(BASE_INPUT);
      expect(html).toContain(`href="${BASE_INPUT.receiptUrl}"`);
    });

    it("contains the org name", () => {
      const { html } = paymentReceiptTemplate(BASE_INPUT);
      expect(html).toContain(BASE_INPUT.orgName);
    });

    it("contains the dollar-formatted amount", () => {
      const { html } = paymentReceiptTemplate(BASE_INPUT);
      expect(html).toContain("$49.99");
    });

    it("contains the description", () => {
      const { html } = paymentReceiptTemplate(BASE_INPUT);
      expect(html).toContain(BASE_INPUT.description);
    });

    it("contains a View receipt CTA label", () => {
      const { html } = paymentReceiptTemplate(BASE_INPUT);
      expect(html).toMatch(/View receipt/);
    });

    it("uses the branded CTA button style", () => {
      const { html } = paymentReceiptTemplate(BASE_INPUT);
      expect(html).toContain("background:#6366f1");
      expect(html).toContain("color:#ffffff");
    });
  });

  describe("HTML escaping via esc()", () => {
    const dangerous = {
      orgName: 'Org & "Friends" <script>',
      amountCents: 1000,
      description: '<img src=x onerror="alert(1)">',
      receiptUrl: "https://example.com/receipt?a=1&b=2",
    };

    it("escapes & in receiptUrl (href) as &amp;", () => {
      const { html } = paymentReceiptTemplate(dangerous);
      expect(html).toContain('href="https://example.com/receipt?a=1&amp;b=2"');
    });

    it("escapes < in orgName as &lt;", () => {
      const { html } = paymentReceiptTemplate(dangerous);
      expect(html).not.toContain("<script>");
    });

    it("escapes < in description as &lt;", () => {
      const { html } = paymentReceiptTemplate(dangerous);
      expect(html).not.toContain("<img");
    });

    it("escapes & and quotes in orgName", () => {
      const { html } = paymentReceiptTemplate(dangerous);
      expect(html).toContain("&amp;");
      expect(html).toContain("&quot;");
    });

    it("does NOT escape plain text (text carries raw values)", () => {
      const { text } = paymentReceiptTemplate(dangerous);
      expect(text).toContain(dangerous.receiptUrl);
      expect(text).toContain(dangerous.orgName);
      expect(text).toContain(dangerous.description);
    });
  });
});
