#!/usr/bin/env node
// render-report.mjs — turn an oxagen code-audit JSON result into a self-contained,
// interactive HTML dashboard styled to the Oxagen design system.
//
// usage:
//   node render-report.mjs --data audit.json --out report.html [--generated-at ISO]
//
// the input JSON is the object returned by the oxagen-code-audit workflow:
//   { meta, unitSummaries, rollup, findings, fixesApplied, fixesSkipped, tickets }
//
// the output is one portable .html file — no network, no build step. open it anywhere.

import { readFileSync, writeFileSync } from 'node:fs'

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dataPath = arg('--data')
const outPath = arg('--out', 'audit-report.html')
const generatedAt = arg('--generated-at', new Date().toISOString())

if (!dataPath) {
  console.error('render-report: --data <audit.json> is required')
  process.exit(1)
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'))

// ---- normalize / defensive defaults --------------------------------------
const meta = data.meta || {}
const rollup = data.rollup || {}
const findings = Array.isArray(data.findings) ? data.findings : []
const unitSummaries = Array.isArray(data.unitSummaries) ? data.unitSummaries : []
const fixesApplied = Array.isArray(data.fixesApplied) ? data.fixesApplied : []
const fixesSkipped = Array.isArray(data.fixesSkipped) ? data.fixesSkipped : []
const tickets = Array.isArray(data.tickets) ? data.tickets : []

const confirmed = findings.filter((f) => f.verdict === 'confirmed')
const weightedHealth = unitSummaries.length
  ? Math.round(unitSummaries.reduce((s, u) => s + (u.healthScore || 0), 0) / unitSummaries.length)
  : 0

// ---- html escaping --------------------------------------------------------
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// data goes into the page as a JSON island the client script reads.
const island = JSON.stringify({
  meta,
  rollup,
  findings,
  unitSummaries,
  fixesApplied,
  fixesSkipped,
  tickets,
  generatedAt,
  weightedHealth,
}).replace(/</g, '\\u003c')

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>oxagen · code audit · ${esc(meta.base || '')}</title>
<style>
  :root {
    --bg: #15151f;
    --bg-2: #1b1c28;
    --panel: rgba(31, 33, 48, 0.55);
    --panel-solid: #1d1f2c;
    --ink: #f3f4f7;
    --ink-dim: #aab0c0;
    --ink-faint: #7a8190;
    --line: rgba(120, 130, 160, 0.22);
    --line-strong: rgba(120, 130, 160, 0.38);
    --teal: #1fd0b5;
    --cyan: #10a7da;
    --blue: #343adc;
    --indigo: #562cf0;
    --violet: #a269ff;
    --green: #28c36b;
    --grad: linear-gradient(105deg, #7182ff 0%, #3cff52 100%);
    --grad-alt: linear-gradient(105deg, #3b4fe6 0%, #be1af0 100%);
    --radius: 14px;
    --radius-lg: 20px;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
    --crit: #ff5a6a;
    --high: #ffa64d;
    --med: #10a7da;
    --low: #7a8190;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    background-image:
      radial-gradient(60% 50% at 18% 0%, rgba(40, 195, 107, 0.10), transparent 60%),
      radial-gradient(55% 45% at 82% 8%, rgba(86, 44, 240, 0.16), transparent 60%),
      radial-gradient(70% 60% at 50% 100%, rgba(16, 167, 218, 0.10), transparent 65%);
    color: var(--ink);
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Inter, system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    letter-spacing: -0.005em;
    min-height: 100vh;
  }
  .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; }
  a { color: var(--teal); text-decoration: none; }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 32px 24px 96px; }

  /* header */
  header.top { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; flex-wrap: wrap; }
  .ring { width: 38px; height: 38px; flex: none; }
  .brand h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -0.02em; }
  .brand .sub { color: var(--ink-faint); font-size: 13px; margin-top: 2px; }
  .meta-pills { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
  .pill {
    font-size: 12px; padding: 5px 11px; border-radius: 999px;
    border: 1px solid var(--line); background: rgba(255,255,255,0.02); color: var(--ink-dim);
  }
  .pill b { color: var(--ink); font-weight: 500; }

  /* kpi grid */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin: 28px 0; }
  .kpi {
    border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px;
    background: var(--panel); backdrop-filter: blur(12px);
    transition: transform 220ms var(--ease), box-shadow 220ms var(--ease);
  }
  .kpi:hover { transform: translateY(-2px); box-shadow: 0 18px 45px rgba(0,0,0,0.35); }
  .kpi .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-faint); }
  .kpi .val { font-size: 30px; font-weight: 600; margin-top: 6px; letter-spacing: -0.02em; }
  .kpi .val small { font-size: 14px; color: var(--ink-faint); font-weight: 400; }
  .kpi .hint { font-size: 12px; color: var(--ink-faint); margin-top: 3px; }

  /* health gauge */
  .gauge-wrap { display: flex; align-items: center; gap: 16px; }
  .gauge { width: 84px; height: 84px; flex: none; }
  .gauge text { fill: var(--ink); font-weight: 600; }

  section { margin: 36px 0; }
  .section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--ink-faint); margin: 0 0 14px; }

  /* bars */
  .bars { display: grid; gap: 10px; }
  .bar-row { display: grid; grid-template-columns: 140px 1fr 44px; align-items: center; gap: 12px; }
  .bar-row .name { font-size: 13px; color: var(--ink-dim); text-transform: capitalize; }
  .bar-track { height: 10px; border-radius: 999px; background: rgba(255,255,255,0.05); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; }
  .bar-row .count { font-size: 13px; text-align: right; color: var(--ink); font-variant-numeric: tabular-nums; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 880px) { .two-col { grid-template-columns: 1fr; } }

  /* unit cards */
  .units { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
  .unit {
    border: 1px solid var(--line); border-radius: var(--radius); padding: 16px;
    background: var(--panel); backdrop-filter: blur(12px);
    transition: transform 220ms var(--ease), border-color 220ms var(--ease);
  }
  .unit:hover { transform: translateY(-2px); border-color: var(--line-strong); }
  .unit .head { display: flex; align-items: center; gap: 12px; }
  .unit .gauge-sm { width: 46px; height: 46px; flex: none; }
  .unit .uname { font-weight: 600; font-size: 14px; }
  .unit .ucounts { font-size: 12px; color: var(--ink-faint); margin-top: 2px; }
  .unit .usum { font-size: 12.5px; color: var(--ink-dim); margin-top: 10px; line-height: 1.5; }

  /* controls */
  .controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
  .controls input[type=search], .controls select {
    background: var(--panel-solid); border: 1px solid var(--line); color: var(--ink);
    border-radius: 10px; padding: 8px 12px; font-size: 13px; font-family: inherit;
  }
  .controls input[type=search] { min-width: 220px; flex: 1; }
  .controls select:focus, .controls input:focus { outline: none; border-color: var(--teal); box-shadow: 0 0 0 3px rgba(31,208,181,0.25); }
  .chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    font-size: 12px; padding: 5px 11px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: var(--ink-dim); user-select: none;
    transition: all 160ms var(--ease);
  }
  .chip[aria-pressed="true"] { color: var(--ink); border-color: var(--line-strong); background: rgba(255,255,255,0.06); }

  /* findings table */
  .tbl { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--panel); backdrop-filter: blur(12px); }
  .row {
    display: grid; grid-template-columns: 8px 1fr 110px 96px 70px; gap: 12px; align-items: center;
    padding: 13px 16px 13px 8px; border-top: 1px solid var(--line); cursor: pointer;
    transition: background 160ms var(--ease);
  }
  .row:first-child { border-top: none; }
  .row:hover { background: rgba(255,255,255,0.03); }
  .sev-tick { width: 4px; height: 34px; border-radius: 999px; margin-left: 8px; }
  .row .title { font-weight: 500; font-size: 13.5px; }
  .row .submeta { font-size: 12px; color: var(--ink-faint); margin-top: 2px; }
  .row .submeta .mono { color: var(--ink-dim); }
  .tag { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink-dim); white-space: nowrap; text-align: center; text-transform: capitalize; }
  .tag.sev { border: none; color: #0c0d14; font-weight: 600; }
  .tag.fix { background: rgba(40,195,107,0.14); border-color: rgba(40,195,107,0.4); color: #6ee7a3; }
  .tag.ticket { background: rgba(255,166,77,0.12); border-color: rgba(255,166,77,0.4); color: var(--high); }
  .tag.fp { opacity: 0.55; text-decoration: line-through; }
  .effort { font-size: 12px; color: var(--ink-faint); text-align: center; }
  .detail { display: none; padding: 4px 18px 20px 20px; border-top: 1px solid var(--line); background: rgba(0,0,0,0.18); }
  .detail.open { display: block; }
  .detail h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.13em; color: var(--ink-faint); margin: 16px 0 6px; }
  .detail pre { margin: 0; padding: 12px 14px; background: #101019; border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; font-size: 12.5px; color: #cdd3e0; white-space: pre-wrap; word-break: break-word; }
  .detail .rec { color: var(--ink); }
  .detail .reason { color: var(--ink-dim); font-style: italic; }
  .empty { padding: 40px; text-align: center; color: var(--ink-faint); }

  /* lists */
  .list { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); backdrop-filter: blur(12px); }
  .list .item { padding: 12px 16px; border-top: 1px solid var(--line); font-size: 13px; }
  .list .item:first-child { border-top: none; }
  .list .item .id { color: var(--ink); font-weight: 500; }
  .list .item .files { color: var(--ink-faint); font-size: 12px; margin-top: 3px; }

  footer { margin-top: 56px; color: var(--ink-faint); font-size: 12px; text-align: center; }
  .count-note { color: var(--ink-faint); font-size: 12.5px; margin: 10px 0 0; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id="ox" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#7182ff"/><stop offset="100%" stop-color="#3cff52"/>
        </linearGradient>
      </defs>
      <path d="M50 8 a42 42 0 1 1 -29.7 12.3" fill="none" stroke="url(#ox)" stroke-width="13" stroke-linecap="round"/>
    </svg>
    <div class="brand">
      <h1>code audit</h1>
      <div class="sub">${esc(meta.generatedFor || 'oxagen-monorepo')} · audited against the engineering law in .agents/skills</div>
    </div>
    <div class="meta-pills">
      <span class="pill">base <b class="mono">${esc(meta.base || '—')}</b></span>
      <span class="pill">branch <b class="mono">${esc(meta.branch || '—')}</b></span>
      <span class="pill">generated <b id="gen-date"></b></span>
    </div>
  </header>

  <div class="kpis">
    <div class="kpi">
      <div class="label">overall health</div>
      <div class="gauge-wrap">
        <svg class="gauge" viewBox="0 0 100 100" id="health-gauge"></svg>
        <div>
          <div class="val" id="health-val"></div>
          <div class="hint">weighted across ${rollup.units || unitSummaries.length} units</div>
        </div>
      </div>
    </div>
    <div class="kpi"><div class="label">confirmed findings</div><div class="val" id="k-confirmed"></div><div class="hint" id="k-confirmed-hint"></div></div>
    <div class="kpi"><div class="label">auto-fixed</div><div class="val" id="k-fixed"></div><div class="hint">applied in this branch</div></div>
    <div class="kpi"><div class="label">needs approval</div><div class="val" id="k-tickets"></div><div class="hint">filed / to file as linear tickets</div></div>
    <div class="kpi"><div class="label">signal quality</div><div class="val" id="k-signal"></div><div class="hint" id="k-signal-hint"></div></div>
  </div>

  <div class="two-col">
    <section>
      <h3 class="section-title">confirmed by severity</h3>
      <div class="bars" id="sev-bars"></div>
    </section>
    <section>
      <h3 class="section-title">confirmed by category</h3>
      <div class="bars" id="cat-bars"></div>
    </section>
  </div>

  <section>
    <h3 class="section-title">unit health</h3>
    <div class="units" id="units"></div>
  </section>

  <section>
    <h3 class="section-title">findings</h3>
    <div class="controls">
      <input type="search" id="q" placeholder="search title, file, rule, evidence…" />
      <select id="f-unit"><option value="">all units</option></select>
      <select id="f-sev"><option value="">all severities</option></select>
      <select id="f-cat"><option value="">all categories</option></select>
      <select id="f-verdict">
        <option value="confirmed">confirmed only</option>
        <option value="">all verdicts</option>
        <option value="uncertain">uncertain</option>
        <option value="false-positive">false-positive</option>
      </select>
    </div>
    <div class="chip-row" style="margin-bottom:14px">
      <span class="chip" data-disp="" aria-pressed="true">all</span>
      <span class="chip" data-disp="applied" aria-pressed="false">auto-fixed</span>
      <span class="chip" data-disp="ticket" aria-pressed="false">needs approval</span>
    </div>
    <div class="tbl" id="tbl"></div>
    <p class="count-note" id="tbl-count"></p>
  </section>

  <div class="two-col">
    <section>
      <h3 class="section-title">fixes applied (<span id="fa-n"></span>)</h3>
      <div class="list" id="fixes"></div>
    </section>
    <section>
      <h3 class="section-title">needs your approval (<span id="tk-n"></span>)</h3>
      <div class="list" id="tk"></div>
    </section>
  </div>

  <footer>
    oxagen code audit · deterministic fan-out audit → adversarial verify → safe auto-fix · rendered offline, no telemetry
  </footer>
</div>

<script id="audit-data" type="application/json">${island}</script>
<script>
const D = JSON.parse(document.getElementById('audit-data').textContent);
const $ = (s, r=document) => r.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const SEV = ['critical','high','medium','low'];
const SEVC = { critical:'#ff5a6a', high:'#ffa64d', medium:'#10a7da', low:'#7a8190' };
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'}); } catch { return iso; } };

$('#gen-date').textContent = fmtDate(D.generatedAt);

// gauge renderer
function gauge(svg, score, size) {
  const r = 40, c = 2*Math.PI*r, off = c*(1 - (score||0)/100);
  const col = score>=80?'#3cff52':score>=60?'#1fd0b5':score>=40?'#ffa64d':'#ff5a6a';
  svg.innerHTML = \`
    <circle cx="50" cy="50" r="\${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="9"/>
    <circle cx="50" cy="50" r="\${r}" fill="none" stroke="\${col}" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="\${c}" stroke-dashoffset="\${off}" transform="rotate(-90 50 50)"/>
    <text x="50" y="\${size<60?'58':'56'}" text-anchor="middle" font-size="\${size<60?'24':'22'}">\${score==null?'—':score}</text>\`;
}
gauge($('#health-gauge'), D.weightedHealth, 84);
$('#health-val').textContent = D.weightedHealth;

const R = D.rollup || {};
const confirmed = D.findings.filter(f => f.verdict === 'confirmed');
$('#k-confirmed').textContent = confirmed.length;
const critHigh = confirmed.filter(f => ['critical','high'].includes(f.verifiedSeverity||f.severity)).length;
$('#k-confirmed-hint').textContent = critHigh + ' critical/high';
$('#k-fixed').innerHTML = (R.fixesApplied||0) + (R.fixesSkipped?' <small>/ '+R.fixesSkipped+' skipped</small>':'');
$('#k-tickets').textContent = R.ticketsNeeded != null ? R.ticketsNeeded : D.tickets.length;
const raw = D.findings.length || 1;
const fpRate = Math.round((R.falsePositive||0)/raw*100);
$('#k-signal').innerHTML = (100-fpRate) + '<small>%</small>';
$('#k-signal-hint').textContent = (R.falsePositive||0) + ' of ' + raw + ' raw flagged false-positive';

// bars
function bars(host, counts, colorFn) {
  const entries = Object.entries(counts||{}).sort((a,b)=>b[1]-a[1]);
  const max = Math.max(1, ...entries.map(e=>e[1]));
  host.innerHTML = '';
  if (!entries.length) { host.appendChild(el('div','count-note','none')); return; }
  for (const [name, n] of entries) {
    const row = el('div','bar-row');
    row.appendChild(el('div','name', esc(name)));
    const track = el('div','bar-track');
    const fill = el('div','bar-fill');
    fill.style.width = Math.round(n/max*100)+'%';
    fill.style.background = colorFn(name);
    track.appendChild(fill); row.appendChild(track);
    row.appendChild(el('div','count', String(n)));
    host.appendChild(row);
  }
}
const sevCounts = {};
SEV.forEach(s => { const n = confirmed.filter(f => (f.verifiedSeverity||f.severity)===s).length; if (n) sevCounts[s]=n; });
bars($('#sev-bars'), Object.keys(sevCounts).length?sevCounts:(R.bySeverityConfirmed||{}), n => SEVC[n]||'#7a8190');
const catCounts = {};
confirmed.forEach(f => { catCounts[f.category]=(catCounts[f.category]||0)+1; });
bars($('#cat-bars'), Object.keys(catCounts).length?catCounts:(R.byCategoryConfirmed||{}), () => 'linear-gradient(90deg,#7182ff,#3cff52)');

// unit cards (sorted worst-health first)
const uhost = $('#units');
[...D.unitSummaries].sort((a,b)=>(a.healthScore||0)-(b.healthScore||0)).forEach(u => {
  const card = el('div','unit');
  const head = el('div','head');
  const g = document.createElementNS('http://www.w3.org/2000/svg','svg');
  g.setAttribute('class','gauge-sm'); g.setAttribute('viewBox','0 0 100 100');
  head.appendChild(g);
  const txt = el('div'); txt.appendChild(el('div','uname', esc(u.unit)));
  txt.appendChild(el('div','ucounts', (u.confirmedCount||0)+' confirmed · '+(u.findingCount||0)+' raw · '+(u.applied||0)+' fixed'));
  head.appendChild(txt); card.appendChild(head);
  if (u.summary) card.appendChild(el('div','usum', esc(u.summary)));
  uhost.appendChild(card);
  gauge(g, u.healthScore, 46);
});

// filters population
const units = [...new Set(D.findings.map(f=>f.unit))].sort();
const cats = [...new Set(D.findings.map(f=>f.category))].sort();
units.forEach(u => $('#f-unit').appendChild(new Option(u, u)));
SEV.forEach(s => $('#f-sev').appendChild(new Option(s, s)));
cats.forEach(c => $('#f-cat').appendChild(new Option(c, c)));

let dispFilter = '';
const state = { q:'', unit:'', sev:'', cat:'', verdict:'confirmed' };

function matches(f) {
  if (state.verdict && f.verdict !== state.verdict) return false;
  if (state.unit && f.unit !== state.unit) return false;
  if (state.sev && (f.verifiedSeverity||f.severity) !== state.sev) return false;
  if (state.cat && f.category !== state.cat) return false;
  if (dispFilter === 'applied' && !f.applied) return false;
  if (dispFilter === 'ticket' && !(f.verdict==='confirmed' && (f.verifiedFixClass||f.fixClass)==='needs-approval')) return false;
  if (state.q) {
    const hay = (f.title+' '+f.file+' '+f.rule+' '+f.evidence+' '+f.recommendation+' '+f.id).toLowerCase();
    if (!hay.includes(state.q.toLowerCase())) return false;
  }
  return true;
}

function render() {
  const host = $('#tbl'); host.innerHTML = '';
  const rows = D.findings.filter(matches).sort((a,b)=>{
    const sa = SEV.indexOf(a.verifiedSeverity||a.severity), sb = SEV.indexOf(b.verifiedSeverity||b.severity);
    return sa-sb;
  });
  $('#tbl-count').textContent = rows.length + ' of ' + D.findings.length + ' findings shown';
  if (!rows.length) { host.appendChild(el('div','empty','no findings match these filters')); return; }
  rows.forEach((f, i) => {
    const sev = f.verifiedSeverity||f.severity;
    const fc = f.verifiedFixClass||f.fixClass;
    const row = el('div','row');
    const tick = el('div','sev-tick'); tick.style.background = SEVC[sev]||'#7a8190'; row.appendChild(tick);
    const main = el('div');
    main.appendChild(el('div','title', esc(f.title)));
    let status = '';
    if (f.applied) status = '<span class="tag fix">fixed</span> ';
    else if (f.verdict==='confirmed' && fc==='needs-approval') status = '<span class="tag ticket">approval</span> ';
    else if (f.verdict==='false-positive') status = '<span class="tag fp">false-positive</span> ';
    else if (f.verdict==='uncertain') status = '<span class="tag">uncertain</span> ';
    main.appendChild(el('div','submeta', status + '<span class="mono">'+esc(f.file)+'</span> · '+esc(f.unit)+' · '+esc(f.rule)));
    row.appendChild(main);
    const tsev = el('div','tag sev', esc(sev)); tsev.style.background = SEVC[sev]||'#7a8190'; row.appendChild(tsev);
    row.appendChild(el('div','tag', esc(f.category)));
    row.appendChild(el('div','effort', esc(f.effort||'')));
    host.appendChild(row);
    const det = el('div','detail');
    det.innerHTML =
      '<h4>evidence</h4><pre>'+esc(f.evidence)+'</pre>'+
      '<h4>recommendation</h4><pre class="rec">'+esc(f.recommendation)+'</pre>'+
      (f.verifyReasoning?'<h4>verifier</h4><pre class="reason">'+esc(f.verifyReasoning)+'</pre>':'')+
      '<h4>meta</h4><pre>id: '+esc(f.id)+'\\nverdict: '+esc(f.verdict)+'  ·  fix-class: '+esc(fc)+'  ·  effort: '+esc(f.effort||'')+'</pre>';
    host.appendChild(det);
    row.addEventListener('click', () => det.classList.toggle('open'));
  });
}

$('#q').addEventListener('input', e => { state.q = e.target.value; render(); });
$('#f-unit').addEventListener('change', e => { state.unit = e.target.value; render(); });
$('#f-sev').addEventListener('change', e => { state.sev = e.target.value; render(); });
$('#f-cat').addEventListener('change', e => { state.cat = e.target.value; render(); });
$('#f-verdict').addEventListener('change', e => { state.verdict = e.target.value; render(); });
document.querySelectorAll('.chip[data-disp]').forEach(c => c.addEventListener('click', () => {
  document.querySelectorAll('.chip[data-disp]').forEach(x => x.setAttribute('aria-pressed','false'));
  c.setAttribute('aria-pressed','true'); dispFilter = c.dataset.disp; render();
}));

// fixes + tickets lists
const fh = $('#fixes'); $('#fa-n').textContent = D.fixesApplied.length;
if (!D.fixesApplied.length) fh.appendChild(el('div','item','<span class="count-note">no auto-fixes applied</span>'));
D.fixesApplied.forEach(a => {
  const it = el('div','item');
  it.innerHTML = '<span class="id">'+esc(a.id)+'</span> — '+esc(a.summary)+'<div class="files mono">'+esc((a.files||[]).join('  ·  '))+'</div>';
  fh.appendChild(it);
});
const th = $('#tk'); $('#tk-n').textContent = D.tickets.length;
if (!D.tickets.length) th.appendChild(el('div','item','<span class="count-note">nothing requires approval</span>'));
D.tickets.forEach(t => {
  const it = el('div','item');
  const sev = t.verifiedSeverity||t.severity;
  it.innerHTML = '<span class="id">'+esc(t.title)+'</span> <span class="tag sev" style="background:'+(SEVC[sev]||'#7a8190')+'">'+esc(sev)+'</span>'+
    '<div class="files">'+esc(t.unit)+' · <span class="mono">'+esc(t.file)+'</span></div>';
  th.appendChild(it);
});

render();
</script>
</body>
</html>`

writeFileSync(outPath, html, 'utf8')
console.log(`render-report: wrote ${outPath} (${(html.length / 1024).toFixed(0)} kb, ${findings.length} findings, ${confirmed.length} confirmed)`)
