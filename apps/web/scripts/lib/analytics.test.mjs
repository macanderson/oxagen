import { describe, expect, it } from "vitest";
import {
  GA_MEASUREMENT_ID,
  googleTag,
  LINKEDIN_PARTNER_ID,
  linkedInInsightTag,
  linkedInNoscript,
  withAnalytics,
} from "./analytics.mjs";

const PAGE =
  "<!doctype html>\n<html><head><title>T</title></head><body><p>x</p></body></html>";

describe("googleTag", () => {
  it("loads gtag.js for the stream and configures it", () => {
    const tag = googleTag();
    expect(tag).toContain(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>`,
    );
    expect(tag).toContain("window.dataLayer = window.dataLayer || [];");
    expect(tag).toContain(`gtag('config', '${GA_MEASUREMENT_ID}');`);
  });

  it("takes an override measurement id", () => {
    const tag = googleTag("G-TEST");
    expect(tag).toContain("gtag/js?id=G-TEST");
    expect(tag).toContain("gtag('config', 'G-TEST');");
    expect(tag).not.toContain(GA_MEASUREMENT_ID);
  });
});

describe("linkedInInsightTag", () => {
  it("carries the partner id and the loader", () => {
    const tag = linkedInInsightTag();
    expect(tag).toContain(`_linkedin_partner_id = "${LINKEDIN_PARTNER_ID}"`);
    expect(tag).toContain("window._linkedin_data_partner_ids");
    expect(tag).toContain(
      "https://snap.licdn.com/li.lms-analytics/insight.min.js",
    );
    expect(tag).toContain("window.lintrk");
  });

  it("takes an override partner id", () => {
    expect(linkedInInsightTag("42")).toContain('_linkedin_partner_id = "42"');
  });
});

describe("linkedInNoscript", () => {
  it("is a hidden 1x1 pixel for the same account", () => {
    const pixel = linkedInNoscript("42");
    expect(pixel).toContain("px.ads.linkedin.com/collect/?pid=42&amp;fmt=gif");
    expect(pixel).toContain('style="display:none;"');
    expect(pixel).toContain('height="1" width="1"');
  });
});

describe("withAnalytics", () => {
  it("puts the loader in the head and the pixel in the body", () => {
    const out = withAnalytics(PAGE);
    expect(out.indexOf("snap.licdn.com")).toBeLessThan(out.indexOf("</head>"));
    const pixel = out.indexOf("px.ads.linkedin.com");
    expect(pixel).toBeGreaterThan(out.indexOf("<body>"));
    expect(pixel).toBeLessThan(out.indexOf("</body>"));
  });

  it("puts the Google tag in the head", () => {
    const out = withAnalytics(PAGE);
    const tag = out.indexOf(`gtag/js?id=${GA_MEASUREMENT_ID}`);
    expect(tag).toBeGreaterThan(out.indexOf("<head>"));
    expect(tag).toBeLessThan(out.indexOf("</head>"));
  });

  it("adds the Google tag to a page that has only the LinkedIn tag", () => {
    const head = `${linkedInInsightTag()}\n</head>`;
    const body = `${linkedInNoscript()}\n</body>`;
    const linkedIn = PAGE.replace("</head>", head).replace("</body>", body);
    const out = withAnalytics(linkedIn);
    expect(out).toContain(`gtag/js?id=${GA_MEASUREMENT_ID}`);
    expect(out.split("_linkedin_partner_id = ").length).toBe(2);
  });

  it("adds the LinkedIn tags to a page that has only the Google tag", () => {
    const googleOnly = PAGE.replace("</head>", `${googleTag()}\n</head>`);
    const out = withAnalytics(googleOnly);
    expect(out).toContain(`_linkedin_partner_id = "${LINKEDIN_PARTNER_ID}"`);
    expect(out).toContain("px.ads.linkedin.com");
    expect(out.split("googletagmanager.com/gtag/js").length).toBe(2);
  });

  it("keeps the page it was given", () => {
    expect(withAnalytics(PAGE)).toContain("<title>T</title>");
    expect(withAnalytics(PAGE)).toContain("<p>x</p>");
  });

  it("is idempotent, so a second build pass cannot double the tag", () => {
    const once = withAnalytics(PAGE);
    expect(withAnalytics(once)).toBe(once);
  });

  it("does not treat another stream's Google tag as its own", () => {
    const other = withAnalytics(PAGE, { measurementId: "G-OTHER" });
    const both = withAnalytics(other);
    expect(both).toContain("gtag/js?id=G-OTHER");
    expect(both).toContain(`gtag/js?id=${GA_MEASUREMENT_ID}`);
  });

  it("does not treat another account's tag as its own", () => {
    const other = withAnalytics(PAGE, { partnerId: "42" });
    const both = withAnalytics(other);
    expect(both).toContain('_linkedin_partner_id = "42"');
    expect(both).toContain(`_linkedin_partner_id = "${LINKEDIN_PARTNER_ID}"`);
  });

  it("refuses a fragment with nowhere to put the tags", () => {
    expect(() => withAnalytics("<div>not a page</div>")).toThrow(
      /no <\/head> or <\/body>/,
    );
  });
});
