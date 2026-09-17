// The third-party tags the published site carries. One module so a tag is
// written once and lands on every page — the hand-authored pages and the
// generated blog alike — instead of being pasted into each <head> by hand.
//
// Nothing here runs in the source tree: the build injects these into dist/,
// so `pnpm dev` serves the same markup production does.

/** LinkedIn ads account whose conversions the Insight Tag reports to. */
export const LINKEDIN_PARTNER_ID = "10042132";

/**
 * The LinkedIn Insight Tag, verbatim from the campaign manager snippet:
 * a partner id pushed onto the queue, then a loader that appends
 * snap.licdn.com/li.lms-analytics/insight.min.js and buffers lintrk() calls
 * made before it arrives.
 * @param {string} partnerId
 */
export function linkedInInsightTag(partnerId = LINKEDIN_PARTNER_ID) {
  return `<script type="text/javascript">
_linkedin_partner_id = "${partnerId}";
window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
window._linkedin_data_partner_ids.push(_linkedin_partner_id);
</script>
<script type="text/javascript">
(function(l) {
if (!l){window.lintrk = function(a,b){window.lintrk.q.push([a,b])};
window.lintrk.q=[]}
var s = document.getElementsByTagName("script")[0];
var b = document.createElement("script");
b.type = "text/javascript";b.async = true;
b.src = "https://snap.licdn.com/li.lms-analytics/insight.min.js";
s.parentNode.insertBefore(b, s);})(window.lintrk);
</script>`;
}

/**
 * The no-script fallback pixel for the same partner id.
 * @param {string} partnerId
 */
export function linkedInNoscript(partnerId = LINKEDIN_PARTNER_ID) {
  return `<noscript>
<img height="1" width="1" style="display:none;" alt="" src="https://px.ads.linkedin.com/collect/?pid=${partnerId}&amp;fmt=gif" />
</noscript>`;
}

/**
 * Put the tags on one page: the loader last in <head>, the pixel last in
 * <body>. Idempotent — a page that already carries the partner id is
 * returned untouched, so re-running the build over dist/ cannot double it.
 * @param {string} html
 * @param {{ partnerId?: string }} [o]
 */
export function withAnalytics(html, { partnerId = LINKEDIN_PARTNER_ID } = {}) {
  if (html.includes(`_linkedin_partner_id = "${partnerId}"`)) return html;
  if (!html.includes("</head>") || !html.includes("</body>")) {
    throw new Error(
      "page has no </head> or </body> to hold the analytics tags",
    );
  }
  return html
    .replace("</head>", `${linkedInInsightTag(partnerId)}\n</head>`)
    .replace("</body>", `${linkedInNoscript(partnerId)}\n</body>`);
}
