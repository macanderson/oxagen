// HTML templates for the blog. Every page links the same shared shell
// (assets/oxagen.css + assets/oxagen.js) the hand-authored pages do, and adds
// assets/blog.css for the parts only the blog has. No colour, no hex, no
// inline style: the palette lives in the stylesheet's token table.

import { PWA_HEAD } from "./pwa-head.generated.mjs";

export const SITE = "https://oxagen.sh";
export const BLOG_TITLE = "Oxagen Research";
export const BLOG_DESCRIPTION =
  "Research notes on ontologies, AI agents, coding agents, self-improving models, self-evolving agents, and autonomous agents. Each note covers what the papers show, where the methods fail, and what it takes to govern the agents built on them.";

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @param {string} iso YYYY-MM-DD */
export function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** @param {string} iso YYYY-MM-DD */
export function rfc822(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toUTCString();
}

export const urls = {
  blog: () => "/blog",
  post: (slug) => `/blog/${slug}`,
  pillar: (slug) => `/blog/pillars/${slug}`,
  feed: () => "/blog/feed.xml",
};

/**
 * The wordmark as inline SVG so it inherits `currentColor` like every other
 * page's brand link. The letters are recoloured to currentColor; the accent
 * `x` keeps the fill the kit cut it with.
 * @param {string} svgFile contents of assets/brand/oxagen-wordmark-on-dark.svg
 */
export function inlineWordmark(svgFile) {
  return svgFile
    .replace(/^<\?xml[^>]*>\s*/, "")
    .replace(/\s(width|height)="[^"]*"/g, "")
    .replace(/ xmlns="[^"]*"/, "")
    .replace(/aria-label="[^"]*"/, 'aria-label="oxagen"')
    .replace(
      /(<path class="letters"[^>]*?)fill="[^"]*"/,
      '$1fill="currentColor"',
    )
    .trim();
}

/* ── the site header ─────────────────────────────────────────────────────── */

// The hive, as the kit cuts it for the lockup: four outlined cells and two
// gold ones. Its outlines follow currentColor, so the mark takes the ink of
// the header it sits in.
const HIVE = `<g transform="translate(21.575,22.616) scale(3.437130)"><path d="M0.000 -6.080L5.800 -3.040L5.800 3.040L0.000 6.080L-5.800 3.040L-5.800 -3.040Z" fill="none" stroke="currentColor" stroke-width="1"/><path d="M13.080 -6.080L18.880 -3.040L18.880 3.040L13.080 6.080L7.280 3.040L7.280 -3.040Z" fill="none" stroke="currentColor" stroke-width="1"/><path d="M6.540 4.160L12.340 7.200L12.340 13.280L6.540 16.320L0.740 13.280L0.740 7.200Z" fill="none" stroke="currentColor" stroke-width="1"/><path d="M19.620 3.660L25.897 6.950L25.897 13.530L19.620 16.820L13.343 13.530L13.343 6.950Z" fill="#D4AF37"/><path d="M0.000 13.900L6.277 17.190L6.277 23.770L0.000 27.060L-6.277 23.770L-6.277 17.190Z" fill="#D4AF37" opacity="0.55"/><path d="M13.080 14.400L18.880 17.440L18.880 23.520L13.080 26.560L7.280 23.520L7.280 17.440Z" fill="none" stroke="currentColor" stroke-width="1"/></g>`;

/**
 * The house lockup: the hive, then the wordmark, on the kit's 604 by 116
 * grid. `wordmark` is the output of inlineWordmark(); its paths are lifted
 * into the lockup unchanged.
 * @param {string} wordmark
 */
export function lockup(wordmark) {
  const inner = wordmark.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg viewBox="0 0 604.125 115.625" role="img" aria-label="oxagen">${HIVE}<g transform="translate(150.257,11.190)">${inner}</g></svg>`;
}

/** The menu icons: 24px line drawings that take currentColor. */
const ICONS = {
  identity:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M15 8h2M15 12h2M7 16h10"/>',
  mandate:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 15 2 2 4-4"/>',
  approval:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  fleet:
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
  runs: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  steering:
    '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"/>',
  spend:
    '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  unproductive:
    '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>',
  budget: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  docs: '<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>',
  start: '<circle cx="12" cy="12" r="10"/><path d="m10 8 6 4-6 4Z"/>',
  api: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  cli: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  mcp: '<path d="M12 22v-5M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  login:
    '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/>',
  signup:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  download:
    '<path d="M12 15V3M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  release:
    '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r=".5"/>',
  protocol:
    '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M10.8 7.2 6.2 16.8M13.2 7.2l4.6 9.6M7.5 19h9"/>',
  paper:
    '<path d="M10 2v7.31M14 9.3V2M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/>',
  story: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  demo: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  help: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.93 4.93 4.24 4.24M14.83 9.17l4.24-4.24M14.83 14.83l4.24 4.24M9.17 14.83l-4.24 4.24"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

/** Stella's asterisk, the one mark in the menus that keeps its gold. */
const STELLA_MARK = `<svg class="mi" viewBox="14 14 68 68" aria-hidden="true"><g transform="translate(13.423,109.664) scale(0.98160)"><path d="M5.88507 -58.2714V-67.369H16.3847L25.7719 -65.7956L26.4302 -67.4381L18.669 -72.8821L11.2665 -80.3931L17.6519 -86.7785L25.163 -79.3761L30.607 -71.6149L32.2494 -72.2732L30.6761 -81.6604V-92.16H39.7737V-81.6604L38.2004 -72.2732L39.8428 -71.6149L45.2868 -79.3761L52.7978 -86.7785L59.1832 -80.3931L51.7808 -72.8821L44.0196 -67.4381L44.6779 -65.7956L54.0651 -67.369H64.5647V-58.2714H54.0651L44.6779 -59.8447L44.0196 -58.2023L51.7808 -52.7583L59.1832 -45.2472L52.7978 -38.8618L45.2868 -46.2642L39.8428 -54.0254L38.2004 -53.3672L39.7737 -43.98V-33.4804H30.6761V-43.98L32.2494 -53.3672L30.607 -54.0254L25.163 -46.2642L17.6519 -38.8618L11.2665 -45.2472L18.669 -52.7583L26.4302 -58.2023L25.7719 -59.8447L16.3847 -58.2714Z" fill="#D4AF37"/></g></svg>`;

/** @param {keyof typeof ICONS} name */
function icon(name) {
  return `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** Attributes for a link that leaves oxagen.sh. */
const EXTERNAL = ' target="_blank" rel="noopener"';

/**
 * One row of a menu: an icon, a name, and one fact about the page.
 * @param {{ href: string, title: string, desc: string, icon?: keyof typeof ICONS, mark?: string, ext?: boolean, current?: boolean }} o
 */
function menuLink(o) {
  const ext = o.ext ? EXTERNAL : "";
  const cur = o.current ? ' aria-current="page"' : "";
  const glyph = o.mark ?? icon(o.icon ?? "arrow");
  return `<a class="mm-a" href="${esc(o.href)}"${ext}${cur}><span class="mm-ic">${glyph}</span><span class="mm-t${o.ext ? " ext" : ""}">${esc(o.title)}</span><span class="mm-d">${esc(o.desc)}</span></a>`;
}

/** @param {string} title @param {string[]} rows */
function menuColumn(title, rows) {
  return `<div class="mm-col"><p class="mm-h">${esc(title)}</p>${rows.join("")}</div>`;
}

/**
 * An open source project with its own links indented under it.
 * @param {{ href: string, title: string, tag: string, desc: string, mark: string, links: Array<{ href: string, label: string }> }} o
 */
function ossCard(o) {
  return `<div class="oss"><a class="mm-a" href="${esc(o.href)}"${EXTERNAL}><span class="mm-ic">${o.mark}</span><span class="mm-t">${esc(o.title)} <span class="tag">${esc(o.tag)}</span></span><span class="mm-d">${esc(o.desc)}</span></a><ul class="oss-sub">${o.links
    .map(
      (l) =>
        `<li><a class="ext" href="${esc(l.href)}"${EXTERNAL}>${esc(l.label)}</a></li>`,
    )
    .join("")}</ul></div>`;
}

/** The supported agents, by the marks the support matrix uses. */
const AGENT_CHIPS = `<span class="mm-chip"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"/></svg>Claude Code</span><span class="mm-chip"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"/></svg>Codex</span><span class="mm-chip"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/></svg>Cursor</span><span class="mm-chip">${STELLA_MARK}Stella</span>`;

/** The Product menu: the four parts of the mandate as three columns, and a card. */
function productMenu() {
  const p = "/products/oxagen";
  return `<div class="mm-cols mm-cols--product">${menuColumn("Agents", [
    menuLink({ href: `${p}#iam`, title: "Identity", desc: "Give each agent its own identity", icon: "identity" }),
    menuLink({ href: `${p}#mandates`, title: "Mandates", desc: "Set what an agent may do and spend", icon: "mandate" }),
    menuLink({ href: `${p}#keys`, title: "Approvals", desc: "Answer the requests a rule sends to a person", icon: "approval" }),
  ])}${menuColumn("Operations", [
    menuLink({ href: `${p}#steer`, title: "Fleet", desc: "See every enrolled agent and its open requests", icon: "fleet" }),
    menuLink({ href: `${p}#recorder`, title: "Runs", desc: "Read what each run did step by step", icon: "runs" }),
    menuLink({ href: `${p}#graph`, title: "Steering", desc: "Hand agents the context they work under", icon: "steering" }),
  ])}${menuColumn("Spend", [
    menuLink({ href: `${p}#dollars`, title: "Spend", desc: "Read your AI bill down to the work", icon: "spend" }),
    menuLink({ href: `${p}#dollars`, title: "Unproductive spend", desc: "Find the spend that bought no progress", icon: "unproductive" }),
    menuLink({ href: `${p}#mandates`, title: "Budgets", desc: "Give each agent a spending limit", icon: "budget" }),
  ])}<a class="mm-feat" href="${p}"><span class="mm-kick">Product</span><span class="mm-ft">Oxagen, the agent control plane</span><span class="mm-fd">Identity, budget, tools, and rules for every agent, and a record of what each one did and spent.</span><span class="mm-go">Read the overview ${icon("arrow")}</span></a></div><div class="mm-foot"><span>Works with</span>${AGENT_CHIPS}<a class="end" href="${p}#support">See the support table ${icon("arrow")}</a></div>`;
}

/**
 * The Research menu: the pillars, the newest posts, and the long reads.
 * @param {{ pillars: Array<{ slug: string, name: string, tagline?: string }>, latest: Array<{ slug: string, title: string, pillar?: string }>, current?: string }} o
 */
function researchMenu({ pillars, latest, current }) {
  const topics = pillars
    .map(
      (p) =>
        `<a class="mm-topic" href="${urls.pillar(p.slug)}"><b>${esc(p.name)}</b>${p.tagline ? `<span>${esc(p.tagline)}</span>` : ""}</a>`,
    )
    .join("");
  const posts = latest
    .map(
      (post) =>
        `<a class="mm-post" href="${urls.post(post.slug)}">${esc(post.title)}${post.pillar ? `<small>${esc(post.pillar)}</small>` : ""}</a>`,
    )
    .join("");
  const all = current === "blog" ? ' aria-current="page"' : "";
  return `<div class="mm-cols mm-cols--research"><div class="mm-col"><p class="mm-h">Topics</p><div class="mm-topics">${topics}</div></div><div class="mm-col"><p class="mm-h">Latest</p>${posts}</div><div class="mm-col mm-stack"><a class="mm-feat" href="/read"><span class="mm-kick">Field manual</span><span class="mm-ft">Engineering deterministic AI coding agents</span><span class="mm-go">Read the field manual ${icon("arrow")}</span></a>${menuLink({ href: "/research/deterministic-systems-optimizations-for-ai-agents", title: "Paper", desc: "Deterministic systems optimizations for AI agents", icon: "paper" })}</div></div><div class="mm-foot"><a href="${urls.blog()}"${all}>All research ${icon("arrow")}</a><a class="ext" href="https://huggingface.co/oxagenai"${EXTERNAL}>Oxagen on Hugging Face</a><a class="end" href="${urls.feed()}">RSS feed</a></div>`;
}

/** The Resources menu: the docs, the open source projects, and the account. */
function resourcesMenu() {
  return `<div class="mm-cols mm-cols--resources">${menuColumn("Documentation", [
    menuLink({ href: "https://docs.oxagen.sh", title: "Docs", desc: "Guides and reference for Oxagen", icon: "docs", ext: true }),
    menuLink({ href: "https://docs.oxagen.sh/getting-started", title: "Getting started", desc: "Enroll your first agent", icon: "start", ext: true }),
    menuLink({ href: "https://docs.oxagen.sh/api", title: "API reference", desc: "Call each capability over HTTP", icon: "api", ext: true }),
    menuLink({ href: "https://docs.oxagen.sh/cli", title: "CLI", desc: "Run governance from your terminal", icon: "cli", ext: true }),
    menuLink({ href: "https://docs.oxagen.sh/mcp", title: "MCP server", desc: "Reach Oxagen from any MCP client", icon: "mcp", ext: true }),
  ])}<div class="mm-col"><p class="mm-h">Open source</p>${ossCard({
    href: "https://stella.oxagen.sh",
    title: "Stella",
    tag: "AGPL-3.0",
    desc: "The open-source coding agent",
    mark: STELLA_MARK,
    links: [
      { href: "https://stella.oxagen.sh/docs", label: "Stella docs" },
      { href: "https://github.com/macanderson/stella", label: "Stella on GitHub" },
    ],
  })}${ossCard({
    href: "https://contextgraphprotocol.org",
    title: "Context Graph Protocol",
    tag: "contextgraph/1.0",
    desc: "An open protocol for agent context",
    mark: icon("protocol"),
    links: [
      { href: "https://contextgraphprotocol.org", label: "Specification" },
      { href: "https://crates.io/crates/contextgraph-types", label: "Rust crates" },
      { href: "https://github.com/macanderson/context-graph-protocol", label: "Protocol on GitHub" },
    ],
  })}</div>${menuColumn("Account", [
    menuLink({ href: "https://app.oxagen.sh", title: "Log in", desc: "Open the operator console", icon: "login", ext: true }),
    menuLink({ href: "https://app.oxagen.sh/signup", title: "Create an account", desc: "Start a new organization", icon: "signup", ext: true }),
    menuLink({ href: "https://downloads.oxagen.sh", title: "Downloads", desc: "Desktop app and CLI installers", icon: "download", ext: true }),
    menuLink({ href: "https://docs.oxagen.sh/releases", title: "Release notes", desc: "What changed in each version", icon: "release", ext: true }),
  ])}</div><div class="mm-foot"><a class="ext" href="https://docs.oxagen.sh/install"${EXTERNAL}>Install guide</a><a href="mailto:success@oxagen.sh">success@oxagen.sh</a><code class="end mm-cmd">npm i -g @oxagen/cli</code></div>`;
}

/** The Company menu: a short list, the legal pages, and the social links. */
function companyMenu() {
  return `<div class="dd">${menuLink({ href: "/story", title: "Our story", desc: "Letting agents write the code", icon: "story" })}${menuLink({ href: "/#demo", title: "Get a demo", desc: "Book a walkthrough with the team", icon: "demo" })}${menuLink({ href: "mailto:hello@oxagen.sh", title: "Contact", desc: "hello@oxagen.sh", icon: "mail" })}${menuLink({ href: "mailto:success@oxagen.sh", title: "Customer success", desc: "success@oxagen.sh", icon: "help" })}<div class="dd-row"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><span class="dd-social"><a href="https://x.com/oxagenai"${EXTERNAL} aria-label="Oxagen on X"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z"/></svg></a><a href="https://www.linkedin.com/company/oxagenai"${EXTERNAL} aria-label="Oxagen on LinkedIn"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.4 20.4h-3.6v-5.6c0-1.3 0-3-1.9-3-1.9 0-2.1 1.4-2.1 2.9v5.7H9.2V9h3.4v1.6h.1c.5-.9 1.6-1.9 3.4-1.9 3.6 0 4.3 2.4 4.3 5.5v6.2zM5.2 7.4a2.1 2.1 0 1 1 0-4.2 2.1 2.1 0 0 1 0 4.2zM7 20.4H3.4V9H7v11.4z"/></svg></a><a href="https://github.com/oxagenai"${EXTERNAL} aria-label="Oxagen on GitHub"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.8A10.2 10.2 0 0 0 1.8 12c0 4.5 2.9 8.3 7 9.7.5.1.7-.2.7-.5v-1.9c-2.9.6-3.5-1.2-3.5-1.2-.4-1.2-1.1-1.5-1.1-1.5-1-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.7-1.4-2.3-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.8-.1-.2-.4-1.3.1-2.7 0 0 .9-.3 2.8 1a9.8 9.8 0 0 1 5.2 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.5.1 2.7.7.7 1 1.7 1 2.8 0 3.9-2.4 4.8-4.6 5 .4.3.7 1 .7 1.9v2.8c0 .3.2.6.7.5a10.2 10.2 0 0 0 7-9.7A10.2 10.2 0 0 0 12 1.8z"/></svg></a></span></div></div>`;
}

/**
 * One top-level item: a button that opens its menu. The menu stays in the
 * markup, so the links are in the page for every reader and crawler;
 * assets/oxagen.js opens it on hover and on click by setting `data-open`
 * on the item. Without script, hover and focus open it from CSS.
 * @param {{ id: string, label: string, menu: string, kind: "mega" | "dd", current?: boolean }} o
 */
function navItem(o) {
  const cur = o.current ? " data-current" : "";
  return `<div class="nav-item nav-item--${o.kind}" data-open="false"${cur}>
        <button class="nav-trigger" type="button" aria-expanded="false" aria-controls="menu-${o.id}">${esc(o.label)}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true">${ICONS.chevron}</svg></button>
        <div class="menu menu--${o.kind}" id="menu-${o.id}"><div class="menu-in">${o.menu}</div></div>
      </div>`;
}

/**
 * The phone menu: one section per top-level item, opened one at a time.
 * It carries no Get a demo; the header keeps the one (#4901).
 * @param {{ pillars: Array<{ slug: string, name: string }> }} o
 */
function drawer({ pillars }) {
  const link = (href, label, ext = false) =>
    `<a${ext ? ' class="ext"' : ""} href="${esc(href)}"${ext ? EXTERNAL : ""}>${esc(label)}</a>`;
  const section = (label, body, open = false) =>
    `<details class="dsec" name="drawer"${open ? " open" : ""}><summary>${esc(label)}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true">${ICONS.chevron}</svg></summary><div class="dsec-in">${body}</div></details>`;
  const p = "/products/oxagen";
  return `<div class="drawer" id="drawer" data-open="false">
  <div class="drawer-in">
    ${section(
      "Product",
      [
        link(p, "Overview"),
        link(`${p}#iam`, "Identity"),
        link(`${p}#mandates`, "Mandates and budgets"),
        link(`${p}#recorder`, "Runs"),
        link(`${p}#dollars`, "Spend"),
        link(`${p}#support`, "Supported agents"),
      ].join(""),
    )}
    ${section(
      "Research",
      [
        link(urls.blog(), "All research"),
        ...pillars.map((pl) => link(urls.pillar(pl.slug), pl.name)),
        link("/read", "Field manual"),
      ].join(""),
    )}
    ${section(
      "Resources",
      [
        `<p class="dsec-h">Documentation</p>`,
        link("https://docs.oxagen.sh", "Docs", true),
        link("https://docs.oxagen.sh/getting-started", "Getting started", true),
        link("https://docs.oxagen.sh/api", "API reference", true),
        `<p class="dsec-h">Open source</p>`,
        `<a class="dsec-group ext" href="https://stella.oxagen.sh"${EXTERNAL}>${STELLA_MARK}Stella</a>`,
        `<div class="dsec-sub">${link("https://stella.oxagen.sh/docs", "Stella docs", true)}${link("https://github.com/macanderson/stella", "Stella on GitHub", true)}</div>`,
        `<a class="dsec-group ext" href="https://contextgraphprotocol.org"${EXTERNAL}>${icon("protocol")}Context Graph Protocol</a>`,
        `<div class="dsec-sub">${link("https://contextgraphprotocol.org", "Specification", true)}${link("https://github.com/macanderson/context-graph-protocol", "Protocol on GitHub", true)}</div>`,
        `<p class="dsec-h">Account</p>`,
        link("https://app.oxagen.sh/signup", "Create an account", true),
        link("https://downloads.oxagen.sh", "Downloads", true),
      ].join(""),
    )}
    ${section(
      "Company",
      [
        link("/story", "Our story"),
        link("mailto:hello@oxagen.sh", "Contact"),
        link("mailto:success@oxagen.sh", "Customer success"),
        link("/terms", "Terms of service"),
        link("/privacy", "Privacy policy"),
      ].join(""),
    )}
    <a class="drawer-login ext" href="https://app.oxagen.sh"${EXTERNAL}>Log in</a>
  </div>
</div>`;
}

/**
 * The header every page on oxagen.sh carries: the floating island with its
 * four menus, and the phone menu. The blog renders it into each page; the
 * build fills the `<!-- site-header -->` placeholder in each hand-written
 * page with the same output (withSiteHeader), so the menus exist once.
 *
 * `demo` picks the header's Get a demo button. A page whose hero holds the
 * gold action passes "ghost", so the screen has one gold button.
 *
 * @param {{ wordmark: string, current?: "blog", demo?: "ghost" | "primary",
 *   pillars?: Array<{ slug: string, name: string, tagline?: string }>,
 *   latest?: Array<{ slug: string, title: string, pillar?: string }> }} o
 */
export function siteHeader({
  wordmark,
  current,
  demo = "primary",
  pillars = [],
  latest = [],
}) {
  return `<header class="nav" id="nav">
  <div class="nav-isl">
    <span class="nav-glass" aria-hidden="true"></span>
    <span class="nav-spot" aria-hidden="true"></span>
    <span class="nav-beam" aria-hidden="true"></span>
    <span class="nav-beam nav-beam-glow" aria-hidden="true"></span>
    <a class="brand" href="/" aria-label="Oxagen home">${lockup(wordmark)}</a>
    <nav class="nav-links" aria-label="Primary">
      ${navItem({ id: "product", label: "Product", kind: "mega", menu: productMenu() })}
      ${navItem({ id: "research", label: "Research", kind: "mega", menu: researchMenu({ pillars, latest, current }), current: current === "blog" })}
      ${navItem({ id: "resources", label: "Resources", kind: "mega", menu: resourcesMenu() })}
      ${navItem({ id: "company", label: "Company", kind: "dd", menu: companyMenu() })}
    </nav>
    <div class="nav-cta">
      <a class="login ext" href="https://app.oxagen.sh"${EXTERNAL}>Log in</a>
      <a class="btn btn-${demo === "ghost" ? "ghost" : "primary"} btn-sm" href="/#demo">Get a demo</a>
      <button class="burger" id="burger" type="button" aria-expanded="false" aria-controls="drawer" aria-label="Menu"><i></i></button>
    </div>
  </div>
</header>

${drawer({ pillars })}`;
}

/**
 * Fill a hand-written page's header placeholder. The placeholder is the
 * comment `<!-- site-header -->`, optionally with `demo="ghost"` inside it:
 * `<!-- site-header demo="ghost" -->`. A page without one is returned as is.
 * @param {string} html
 * @param {(o: { demo: "ghost" | "primary" }) => string} render
 */
export function withSiteHeader(html, render) {
  return html.replace(
    /<!--\s*site-header(?:\s+demo="(ghost|primary)")?\s*-->/g,
    (_, demo) => render({ demo: demo === "ghost" ? "ghost" : "primary" }),
  );
}

/**
 * The newest posts for the Research menu, each named with its first pillar.
 * `posts` arrive sorted newest first (sortPosts).
 * @param {Array<{ slug: string, title: string, pillars: string[] }>} posts
 * @param {Array<{ slug: string, name: string }>} pillars
 * @param {number} [count]
 */
export function latestPosts(posts, pillars, count = 4) {
  const names = new Map(pillars.map((p) => [p.slug, p.name]));
  return posts.slice(0, count).map((post) => ({
    slug: post.slug,
    title: post.title,
    pillar: names.get(post.pillars[0]),
  }));
}

// The footer's theme control and the head script that applies the stored
// choice before first paint. index.html and products/oxagen/index.html carry
// copies of both; change all three together. oxagen.js wires the buttons.
export const THEME_SWITCH = `<div class="theme-switch" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked="true" data-theme-choice="system" aria-label="System" title="System"><svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>
          <button type="button" role="radio" aria-checked="false" tabindex="-1" data-theme-choice="light" aria-label="Light" title="Light"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg></button>
          <button type="button" role="radio" aria-checked="false" tabindex="-1" data-theme-choice="dark" aria-label="Dark" title="Dark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button>
        </div>`;

export const THEME_HEAD = `<script>
/* Stamp the theme before first paint: a pinned choice from the footer's
   control, else the OS. oxagen.js keeps it current after load. */
(function (d) {
  d.classList.add("js");
  var c = null;
  try { c = localStorage.getItem("theme"); } catch (e) {}
  var t = c === "light" || c === "dark" ? c
    : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  d.setAttribute("data-theme", t);
  var m = document.querySelector('meta[name="color-scheme"]');
  if (m) m.content = t;
  if (c === t) {
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (x) {
      x.content = t === "light" ? "#FFFFFF" : "#09090B";
    });
  }
})(document.documentElement);
</script>`;

/** @param {{ wordmark: string, pillars: Array<{slug: string, name: string}> }} o */
export function siteFooter({ wordmark, pillars }) {
  return `<footer>
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <a class="brand" href="/" aria-label="Oxagen home">${wordmark}</a>
        <p>See which agent spent what,<br>and on whose behalf.</p>
      </div>
      <nav class="foot-col" aria-label="Product">
        <h4>Product</h4>
        <ul>
          <li><a href="/products/oxagen">Oxagen, the agent control plane</a></li>
          <li><a href="/#demo">Get a demo</a></li>
        </ul>
      </nav>
      <nav class="foot-col" aria-label="Research">
        <h4>Research</h4>
        <ul>
          <li><a href="/blog">All posts</a></li>
${pillars.map((p) => `          <li><a href="${urls.pillar(p.slug)}">${esc(p.name)}</a></li>`).join("\n")}
          <li><a href="${urls.feed()}">RSS feed</a></li>
        </ul>
      </nav>
      <nav class="foot-col" aria-label="Resources">
        <h4>Resources</h4>
        <ul>
          <li><a class="ext" href="https://docs.oxagen.sh" target="_blank" rel="noopener">Documentation</a></li>
          <li><a class="ext" href="https://app.oxagen.sh" target="_blank" rel="noopener">Customer login</a></li>
          <li><a href="/#field-manual">Field manual</a></li>
          <li><a class="ext" href="https://github.com/oxagenai" target="_blank" rel="noopener">GitHub</a></li>
        </ul>
      </nav>
      <nav class="foot-col" aria-label="Legal">
        <h4>Legal</h4>
        <ul>
          <li><a href="/terms">Terms of service</a></li>
          <li><a href="/privacy">Privacy policy</a></li>
        </ul>
      </nav>
      <div class="foot-col">
        <h4>Contact</h4>
        <address>
          Oxagen, Inc.<br>
          2261 Market Street STE 87168<br>
          San Francisco, CA 94114<br>
          <a href="mailto:hello@oxagen.sh">hello@oxagen.sh</a><br>
          <a href="mailto:success@oxagen.sh">success@oxagen.sh</a><br>
          <a href="tel:+13102137912">+1 (310) 213-7912</a>
        </address>
      </div>
    </div>
    <div class="foot-base">
      <span>© ${new Date().getUTCFullYear()} Oxagen, Inc. All rights reserved.</span>
      <div class="foot-end">
        <span class="mono">agent control plane · <a href="/#field-manual">read the manual</a></span>
        ${THEME_SWITCH}
      </div>
    </div>
  </div>
</footer>`;
}

/**
 * Space Grotesk sets every h1, h2, and h3 on a blog page (Mac, 2026-10-02,
 * oxageninc/brand#83), and the wordmark is an SVG. Each heading takes the
 * site's heading weight, 600, so every blog page preloads that one file. A
 * page built with no heading face (`heroFont` unset) preloads none.
 */
export const HERO_FONT_PRELOAD =
  '<link rel="preload" href="/fonts/space-grotesk-latin-600.woff2" as="font" type="font/woff2" crossorigin>';

/**
 * The document shell shared by every blog page.
 * @param {{
 *   title: string, description: string, path: string, image: string,
 *   imageAlt?: string,
 *   type?: "website" | "article", ldjson?: object, body: string,
 *   wordmark: string, pillars: Array<{slug: string, name: string}>,
 *   latest?: Array<{slug: string, title: string, pillar?: string}>,
 *   extraHead?: string, heroFont?: boolean,
 * }} o
 */
export function layout(o) {
  const url = SITE + o.path;
  const image = o.image.startsWith("http") ? o.image : SITE + o.image;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFFFF">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#09090B">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="${o.type ?? "website"}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:site_name" content="Oxagen">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(o.imageAlt ?? o.title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@oxagenai">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="alternate" type="application/rss+xml" title="${esc(BLOG_TITLE)}" href="${urls.feed()}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/oxagen.webmanifest">
${PWA_HEAD}
${o.heroFont ? `${HERO_FONT_PRELOAD}\n` : ""}${o.ldjson ? `<script type="application/ld+json">\n${JSON.stringify(o.ldjson, null, 2).replace(/</g, "\\u003c")}\n</script>` : ""}
${THEME_HEAD}
<link rel="stylesheet" href="/assets/oxagen.css">
<link rel="stylesheet" href="/assets/blog.css">
${o.extraHead ?? ""}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${siteHeader({ wordmark: o.wordmark, current: "blog", pillars: o.pillars, latest: o.latest })}
<main id="main">
${o.body}
</main>
${siteFooter({ wordmark: o.wordmark, pillars: o.pillars })}
<script src="/assets/oxagen.js" defer></script>
</body>
</html>
`;
}

/** @param {Array<{slug: string, name: string}>} pillars @param {string[]} slugs */
export function pillarChips(pillars, slugs) {
  const byslug = new Map(pillars.map((p) => [p.slug, p]));
  return `<ul class="chips" aria-label="Pillars">${slugs
    .map((s) => {
      const p = byslug.get(s);
      return p
        ? `<li><a class="chip" href="${urls.pillar(p.slug)}">${esc(p.name)}</a></li>`
        : "";
    })
    .join("")}</ul>`;
}

/**
 * A generated image. There is one rendering, on ink: the site is ink, and an
 * ink image reads on a paper ground where a paper image on paper would not,
 * so nothing is offered to a viewer who prefers light.
 * @param {string} src
 * @param {{ alt: string, width: number, height: number, lazy?: boolean, priority?: boolean }} o
 */
export function picture(src, o) {
  const loading = o.lazy ? ' loading="lazy"' : "";
  const priority = o.priority ? ' fetchpriority="high"' : "";
  return `<img src="${esc(src)}" alt="${esc(o.alt)}" width="${o.width}" height="${o.height}"${loading} decoding="async"${priority}>`;
}

/**
 * A page's banner laid behind its title: the picture fills the section and
 * the stylesheet masks it out toward the words, so the prose sits on ink
 * and the drawing comes through beside it. Decorative, so hidden from
 * readers who hear the page.
 * @param {string} src
 */
export function heroArt(src) {
  return `<div class="hero-art" aria-hidden="true">${picture(src, { alt: "", width: 2400, height: 1200, priority: true })}</div>`;
}

/**
 * @param {object} post with `images` from the build
 * @param {Array<{slug: string, name: string}>} pillars
 */
export function postCard(post, pillars) {
  return `<article class="post-card">
  <a class="post-card-shot" href="${urls.post(post.slug)}" tabindex="-1" aria-hidden="true">${picture(post.images.thumb, { alt: "", width: 960, height: 480, lazy: true })}</a>
  <div class="post-card-meta">
    ${pillarChips(pillars, post.pillars)}
    <h3><a href="${urls.post(post.slug)}">${esc(post.title)}</a></h3>
    <p>${esc(post.description)}</p>
    <p class="byline"><time datetime="${post.date}">${formatDate(post.date)}</time> · ${post.readingMinutes} min read</p>
  </div>
</article>`;
}

/** @param {{ pillars: object[], posts: object[], wordmark: string, image: string, latest?: object[] }} o */
export function indexPage({ pillars, posts, wordmark, image, latest }) {
  const body = `
  <section class="blog-hero tex tex-hex">
    <div class="wrap">
      <p class="eyebrow">Research</p>
      <h1>What the research says about agents,<br><span class="gold">and how to govern them</span></h1>
      <p class="blog-hero-sub">${esc(BLOG_DESCRIPTION)}</p>
    </div>
  </section>
  <section class="sec-tight">
    <div class="wrap">
      <div class="sec-head"><p class="eyebrow">Pillars</p><h2>Research topics</h2><p>Every post belongs to at least one pillar. Open a pillar to see all of its posts.</p></div>
      <div class="pillar-grid">
${pillars
  .map(
    (p) => `        <a class="pillar-card" href="${urls.pillar(p.slug)}">
          ${picture(p.images.thumb, { alt: "", width: 960, height: 480, lazy: true })}
          <div class="pillar-card-body"><h3>${esc(p.name)}</h3><p>${esc(p.tagline)}</p><span class="pillar-count">${posts.filter((x) => x.pillars.includes(p.slug)).length} posts</span></div>
        </a>`,
  )
  .join("\n")}
      </div>
    </div>
  </section>
  <section class="sec-tight sec-alt">
    <div class="wrap">
      <div class="sec-head"><p class="eyebrow">Latest</p><h2>All posts</h2></div>
      <div class="post-grid">
${posts.map((p) => postCard(p, pillars)).join("\n")}
      </div>
    </div>
  </section>`;
  return layout({
    title: `${BLOG_TITLE}: the science of ontologies, agents, and self-improving systems`,
    description: BLOG_DESCRIPTION,
    path: urls.blog(),
    image,
    imageAlt: BLOG_TITLE,
    body,
    wordmark,
    pillars,
    latest,
    heroFont: true,
    ldjson: {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: BLOG_TITLE,
      url: SITE + urls.blog(),
      description: BLOG_DESCRIPTION,
      publisher: { "@type": "Organization", name: "Oxagen, Inc.", url: SITE },
    },
  });
}

/** @param {{ pillar: object, pillars: object[], posts: object[], wordmark: string, latest?: object[] }} o */
export function pillarPage({ pillar, pillars, posts, wordmark, latest }) {
  const body = `
  <section class="pillar-hero hero-field">
    ${heroArt(pillar.images.banner)}
    <div class="wrap"><div class="pillar-hero-copy">
      <p class="eyebrow"><a href="${urls.blog()}">Research</a> · Pillar</p>
      <h1>${esc(pillar.name)}</h1>
      <p class="pillar-tagline">${esc(pillar.tagline)}</p>
      <p class="pillar-desc">${esc(pillar.description)}</p>
    </div></div>
  </section>
  <section class="sec-tight sec-alt">
    <div class="wrap">
      <div class="sec-head"><h2>${posts.length === 1 ? "1 post" : `${posts.length} posts`} in ${esc(pillar.name)}</h2></div>
      ${posts.length ? `<div class="post-grid">\n${posts.map((p) => postCard(p, pillars)).join("\n")}\n      </div>` : `<p class="empty">Nothing here yet. <a href="${urls.blog()}">See all posts.</a></p>`}
      <nav class="pillar-nav" aria-label="Other pillars">
        <span class="mono">Other pillars</span>
        ${pillars
          .filter((p) => p.slug !== pillar.slug)
          .map(
            (p) =>
              `<a class="chip" href="${urls.pillar(p.slug)}">${esc(p.name)}</a>`,
          )
          .join("\n        ")}
      </nav>
    </div>
  </section>`;
  return layout({
    title: `${pillar.name} · ${BLOG_TITLE}`,
    description: pillar.description,
    path: urls.pillar(pillar.slug),
    image: pillar.images.og,
    imageAlt: pillar.name,
    body,
    wordmark,
    pillars,
    latest,
    heroFont: true,
    ldjson: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: pillar.name,
      url: SITE + urls.pillar(pillar.slug),
      description: pillar.description,
      isPartOf: { "@type": "Blog", name: BLOG_TITLE, url: SITE + urls.blog() },
    },
  });
}

/**
 * @param {{ post: object, html: string, headings: Array<{depth: number, id: string, text: string}>,
 *   pillars: object[], related: object[], wordmark: string, latest?: object[] }} o
 */
export function postPage({ post, html, headings, pillars, related, wordmark, latest }) {
  // remark-rehype hardcodes the footnote section's heading id; keep it out of the TOC
  const toc = headings.filter(
    (h) => h.depth === 2 && h.id !== "footnote-label",
  );
  const primary = pillars.find((p) => p.slug === post.pillars[0]);
  const body = `
  <article class="post">
    <header class="post-head hero-field">
      ${heroArt(post.images.banner)}
      <div class="wrap"><div class="post-head-in">
        <p class="eyebrow"><a href="${urls.blog()}">Research</a> · <a href="${urls.pillar(primary.slug)}">${esc(primary.name)}</a></p>
        <h1>${esc(post.title)}</h1>
        <p class="post-sub">${esc(post.description)}</p>
        <p class="byline">
          <span>${post.authors.map(esc).join(", ")}</span> ·
          <time datetime="${post.date}">${formatDate(post.date)}</time>${post.updated ? ` · updated <time datetime="${post.updated}">${formatDate(post.updated)}</time>` : ""} ·
          <span>${post.readingMinutes} min read</span>
        </p>
        ${pillarChips(pillars, post.pillars)}
      </div></div>
    </header>
    <div class="wrap post-body">
      ${toc.length > 1 ? `<nav class="toc" aria-label="In this post"><p class="mono">In this post</p><ol>${toc.map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join("")}</ol></nav>` : ""}
      <div class="prose">
${html}
      </div>
    </div>
    <footer class="post-foot">
      <div class="wrap">
        ${post.tags.length ? `<p class="tags mono">${post.tags.map((t) => `<span>#${esc(t)}</span>`).join(" ")}</p>` : ""}
        ${related.length ? `<div class="sec-head"><p class="eyebrow">Keep reading</p><h2>Related posts</h2></div><div class="post-grid">${related.map((r) => postCard(r, pillars)).join("\n")}</div>` : ""}
      </div>
    </footer>
  </article>`;
  return layout({
    title: `${post.title} · ${BLOG_TITLE}`,
    description: post.description,
    path: urls.post(post.slug),
    image: post.images.og,
    imageAlt: post.title,
    type: "article",
    body,
    wordmark,
    pillars,
    latest,
    heroFont: true,
    extraHead: `<meta property="article:published_time" content="${post.date}">${post.updated ? `\n<meta property="article:modified_time" content="${post.updated}">` : ""}${post.pillars.map((p) => `\n<meta property="article:section" content="${esc(pillars.find((x) => x.slug === p)?.name ?? p)}">`).join("")}${post.tags.map((t) => `\n<meta property="article:tag" content="${esc(t)}">`).join("")}`,
    ldjson: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      dateModified: post.updated ?? post.date,
      author: post.authors.map((name) => ({ "@type": "Organization", name })),
      publisher: {
        "@type": "Organization",
        name: "Oxagen, Inc.",
        url: SITE,
        logo: `${SITE}/assets/brand/oxagen-wordmark.svg`,
      },
      image: SITE + post.images.og,
      url: SITE + urls.post(post.slug),
      mainEntityOfPage: SITE + urls.post(post.slug),
      keywords: [
        ...post.pillars.map(
          (p) => pillars.find((x) => x.slug === p)?.name ?? p,
        ),
        ...post.tags,
      ].join(", "),
      wordCount: post.wordCount,
      isPartOf: { "@type": "Blog", name: BLOG_TITLE, url: SITE + urls.blog() },
    },
  });
}

/** @param {object[]} posts newest first @param {object[]} pillars */
export function feedXml(posts, pillars) {
  const items = posts
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE}${urls.post(p.slug)}</link>
      <guid isPermaLink="true">${SITE}${urls.post(p.slug)}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${esc(p.description)}</description>
${p.pillars.map((s) => `      <category>${esc(pillars.find((x) => x.slug === s)?.name ?? s)}</category>`).join("\n")}
    </item>`,
    )
    .join("\n");
  const last = posts[0]
    ? rfc822(posts[0].date)
    : rfc822(new Date().toISOString().slice(0, 10));
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(BLOG_TITLE)}</title>
    <link>${SITE}${urls.blog()}</link>
    <atom:link href="${SITE}${urls.feed()}" rel="self" type="application/rss+xml"/>
    <description>${esc(BLOG_DESCRIPTION)}</description>
    <language>en-us</language>
    <lastBuildDate>${last}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

/**
 * Merge the hand-maintained sitemap (static pages) with the blog's URLs.
 * @param {string} existingXml the committed sitemap.xml
 * @param {Array<{loc: string, lastmod?: string, changefreq?: string}>} entries
 */
export function mergeSitemap(existingXml, entries) {
  const close = existingXml.lastIndexOf("</urlset>");
  if (close < 0) throw new Error("sitemap.xml has no </urlset>");
  const existing = new Set(
    [...existingXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
  );
  const added = entries
    .filter((e) => !existing.has(e.loc))
    .map(
      (e) =>
        `  <url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}<changefreq>${e.changefreq ?? "monthly"}</changefreq></url>`,
    )
    .join("\n");
  return `${existingXml.slice(0, close).trimEnd()}\n${added}\n</urlset>\n`;
}
