import { describe, it, expect } from "vitest";
import { reauthEmailTemplate } from "./email-templates";

describe("reauthEmailTemplate", () => {
  const baseInput = {
    serverName: "GitHub",
    reauthUrl: "https://app.oxagen.ai/reauth?token=abc123",
    orgName: "Acme Corp",
  };

  describe("subject", () => {
    it("contains the server name", () => {
      const { subject } = reauthEmailTemplate(baseInput);
      expect(subject).toContain("GitHub");
    });

    it("mentions reconnect action", () => {
      const { subject } = reauthEmailTemplate(baseInput);
      expect(subject).toMatch(/reconnect/i);
    });
  });

  describe("text", () => {
    it("contains the org name", () => {
      const { text } = reauthEmailTemplate(baseInput);
      expect(text).toContain("Acme Corp");
    });

    it("contains the server name", () => {
      const { text } = reauthEmailTemplate(baseInput);
      expect(text).toContain("GitHub");
    });

    it("contains the reauth URL verbatim", () => {
      const { text } = reauthEmailTemplate(baseInput);
      expect(text).toContain(baseInput.reauthUrl);
    });
  });

  describe("html", () => {
    it("contains an anchor with the reauth URL as href", () => {
      const { html } = reauthEmailTemplate(baseInput);
      expect(html).toContain(`href="${baseInput.reauthUrl}"`);
    });

    it("contains the server name in anchor text", () => {
      const { html } = reauthEmailTemplate(baseInput);
      // The CTA button text is "Reconnect <serverName>"
      expect(html).toContain("Reconnect GitHub");
    });

    it("contains the org name", () => {
      const { html } = reauthEmailTemplate(baseInput);
      expect(html).toContain("Acme Corp");
    });
  });

  describe("esc() — HTML escaping in html output", () => {
    const dangerousInput = {
      serverName: 'A&B<C>"D',
      reauthUrl: "https://example.com/reauth?a=1&b=2",
      orgName: "<Danger>&",
    };

    it("escapes & in serverName as &amp;", () => {
      const { html } = reauthEmailTemplate(dangerousInput);
      // The escaped form must appear
      expect(html).toContain("A&amp;B");
      // The raw ampersand in the serverName must NOT appear unescaped
      // (check the specific sequence 'A&B' is absent)
      expect(html).not.toContain("A&B<");
    });

    it("escapes < in serverName as &lt;", () => {
      const { html } = reauthEmailTemplate(dangerousInput);
      expect(html).toContain("B&lt;C");
      expect(html).not.toContain("B<C");
    });

    it("escapes > in serverName as &gt;", () => {
      const { html } = reauthEmailTemplate(dangerousInput);
      expect(html).toContain("C&gt;");
    });

    it('escapes " in serverName as &quot;', () => {
      const { html } = reauthEmailTemplate(dangerousInput);
      expect(html).toContain("&quot;D");
      // Raw double-quote from serverName must not appear unescaped in html
      // (note: the href itself uses esc() so url & is also escaped there)
      expect(html).not.toContain('"D');
    });

    it("escapes & in reauthUrl (href) as &amp;", () => {
      const { html } = reauthEmailTemplate(dangerousInput);
      // The href uses esc(reauthUrl), so & in the query string → &amp;
      expect(html).toContain('href="https://example.com/reauth?a=1&amp;b=2"');
    });

    it("escapes < and > in orgName", () => {
      const { html } = reauthEmailTemplate(dangerousInput);
      expect(html).toContain("&lt;Danger&gt;");
      expect(html).not.toContain("<Danger>");
    });

    it("escapes & in orgName as &amp;", () => {
      const { html } = reauthEmailTemplate(dangerousInput);
      // orgName is "<Danger>&" — the & part should be &amp;
      expect(html).toContain("&gt;&amp;");
    });

    it("rejects a javascript: scheme in reauthUrl (href XSS guard)", () => {
      expect(() =>
        reauthEmailTemplate({
          ...baseInput,
          reauthUrl: "javascript:alert(document.cookie)",
        }),
      ).toThrow(/Unsafe URL scheme/);
    });

    it("rejects a non-http(s) scheme in reauthUrl", () => {
      expect(() =>
        reauthEmailTemplate({
          ...baseInput,
          reauthUrl: "data:text/html,<script>alert(1)</script>",
        }),
      ).toThrow(/Unsafe URL scheme/);
    });

    it("does NOT escape in plain text output (text carries raw values)", () => {
      const { text } = reauthEmailTemplate(dangerousInput);
      // text is unescaped, so raw values appear as-is
      expect(text).toContain('A&B<C>"D');
      expect(text).toContain("<Danger>&");
      expect(text).toContain("https://example.com/reauth?a=1&b=2");
    });
  });
});
