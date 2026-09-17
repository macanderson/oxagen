import { describe, expect, it } from "vitest";
import {
  LINKEDIN_PARTNER_ID,
  linkedInInsightTag,
  linkedInNoscript,
  withAnalytics,
} from "./analytics.mjs";

const PAGE =
  "<!doctype html>\n<html><head><title>T</title></head><body><p>x</p></body></html>";

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

  it("keeps the page it was given", () => {
    expect(withAnalytics(PAGE)).toContain("<title>T</title>");
    expect(withAnalytics(PAGE)).toContain("<p>x</p>");
  });

  it("is idempotent, so a second build pass cannot double the tag", () => {
    const once = withAnalytics(PAGE);
    expect(withAnalytics(once)).toBe(once);
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
