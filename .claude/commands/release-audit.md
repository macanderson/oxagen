---
description: Pre-merge release-readiness audit for Oxagen. Audits architecture, compliance, multi-tenancy, infra cost, tests, build performance, docs, and PR hygiene, then drives green PRs to merge and monitors deploy.
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Task, LSP, Skill, Agent, TodoWrite, ToolSearch, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, KillShell, ExitPlanMode, mcp__plugin_github_github__create_or_update_file, mcp__plugin_github_github__get_file_contents, mcp__claude_ai_Linear__get_milestone, mcp__claude_ai_Linear__save_milestone, mcp__claude_ai_Linear__save_status_update, mcp__claude_ai_Linear__save_issue, mcp__claude_ai_Linear__search_documentation, mcp__claude_ai_Linear__list_issue_labels, mcp__claude_ai_Linear__list_projects, mcp__claude_ai_Linear__list_teams, mcp__claude_ai_Vercel__get_deployment_build_logs, mcp__claude_ai_Linear__get_issue, mcp__claude_ai_Linear__save_comment
---

# /release-audit

Run a full release-readiness sweep on the current branch and open PRs. Work top to bottom.

**Halt and ask** before any destructive changes. Other than that, work autonomously and manage the resulting fix pull request through feedback resolution, ci green, production deploy, and production ci green.

**Fix all non-destructive issues in one pull request.**

**Produce a single HTML report at the end** with PASS / WARN / FAIL per check, a
prioritized fix list, **and a readiness scorecard.** Every score is a 0–100 number
(100 = flawless, 0 = worst possible) computed by the **Scoring** rubric below —
deterministic deductions from concrete evidence, never a vibe. Each score must
carry the evidence that produced it (which checks/counts/ratios drove the
deductions) and a **confidence** flag (`high` = measured, `med` = partially
measured, `low` = inferred). Required scores:

- **Maintainability**, **Security**, **SOC 2 compliance**, **GDPR compliance**,
  **PCI compliance**
- **App maturity** — one score per directory under `apps/`, enumerated live in
  Phase 0 (never hard-code the list)
- **Package maturity** — one score per project under `packages/`, enumerated live
  in Phase 0 (never hard-code the list)
- **Ops / CI maturity**, **Observability / logging / telemetry**
- **Documentation — end-user docs** and **Documentation — internal docs** (two
  separate scores)
- **Overall platform stability**, plus one top-line **Release-readiness composite**
  with a **GO / NO-GO** verdict

The `Scoring`, `Output`, and `Execution model` sections define how to compute the
scores, what artifact to produce, and how to parallelize. All audit phases run in
parallel after `Phase 0 — Load context` completes; the **Scoring** synthesis runs
once every auditor has returned.


## Phase 0 — Load context

- **Read** `.agents/skills/**/SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `SPEC.md`. Treat skill principles as the rubric for every code check below.
- `git fetch --all --prune`. Capture current branch, `main` SHA, and dirty state.
- **Identify tenant/workspace scoping convention from the schema** and RLS policies so later checks reference the real column names, not assumptions.

## Phase 1 — Architecture Audit

1. **Overengineering.** Flag features with abstraction depth disproportionate to use: single-implementation interfaces, factories with one product, premature generics, config for things that never vary. Cite file + rationale.

2. **NotImplemented.** `grep -rn "NotImplementedError\|raise NotImplemented\|todo!()\|unimplemented!()\|panic!(\"not"` across `apps/` and `packages/`. Any hit on a reachable code path is a FAIL.

3. **Vendor lock.** Find direct SDK/API calls (Stripe, OpenAI/Anthropic, Neo4j driver, Plaid, Google) used outside a `packages/*/adapters` or `clients/` boundary. A vendor SDK imported directly into domain or route code without a thin port is a WARN→FAIL if it's a swappable concern.

4. **Dead schema.** For each table/model, grep for read+write usage. A table with a migration but zero CRUD references in code is a FAIL (orphan schema).

5. **Append-only hygiene.**
   - Soft-delete (`deleted_at`) or audit (`updated_at`, `updated_by`) columns on tables that are conceptually append-only → WARN, they imply mutation that shouldn't happen.
   - High-volume append-only tables (events, traces, ledger) configured to `TRUNCATE` or lacking partition/retention strategy → FAIL. Recommend time-based partitioning instead.

## Phase 2 — Compliance Audit

6. **SOC 2 risks.** Scan for: secrets in code or env files committed, logging of PII/tokens, missing audit trail on privileged mutations, auth bypass, disabled TLS verification, broad IAM grants. Anything that breaks an access-control or audit-logging control is a FAIL.

7. **RLS / tenant scoping.** For every table that should be tenant or tenant+workspace scoped, confirm a row-level security policy or an enforced query-time filter exists. A scoped table with no RLS policy and no centralized filter is a **FAIL — data isolation gap**. List each missing table explicitly.

## Phase 3 — Infra Auditor

8. **Premature spend.** Review IaC (Terraform/Pulumi/GCP config) for resources oversized for a pre-revenue, zero-live-customer stage: standing GPU instances, multi-region replicas, large always-on AlloyDB tiers, provisioned-but-idle Neo4j, expensive managed tiers. Recommend downscale or scale-to-zero. WARN with estimated monthly cost where derivable.

9. **Portability assessment** Review the infrastructure changes (if any) and assess the infrastructure for issues related to portability. This stack must be able to be ported between cloud service providers with relative ease.

10. **Environment Variables & Secrets check** Review the vercel environment variables for all deployed services and ensure they contain non placeholder values and that the turbo.json at the root of this repo has the right env vars and secrets corresponding to the right build tasks and we have no unused/stale env vars or secrets. Also check for how the env vars and secrets are stored, making sure only true secrets are stored as encrypted. Ensure the .env.example files in the root of each project reflect reality and that the root .env.example has all of the vars and secrets required with inline comments referencing the apps/services that depend on them, as well as the value differences between local dev, preview, and production environments.


## Phase 4 — Quality gates

11. **Skill adherence.** Re-check the diff against each `.agents/skills` principle. List violations per skill.
12. **Regressions.** Run only the affected graph on PRs: `turbo run test --filter='...[origin/main]'`. Full suite runs on `main` post-merge. Any newly failing test vs `main` is a FAIL.
13. **Test coverage — leading bar, enforced.**
    - Target ≥85% line / ≥80% branch on changed packages; whole untested modules are a FAIL regardless of repo average.
    - Enforce per-package thresholds in config (vitest `coverage.thresholds`, pytest `--cov-fail-under`) so the gate lives in the build, not in review.
    - Coverage runs on the **affected graph only** on PRs; the merged report is assembled from per-package artifacts, not a full re-run.
    - Flag missing-test modules AND assertion-light tests (tests that execute code but assert little) — the second is a WARN that inflates coverage without catching regressions.
14. **Headless parity.** Verify every user-facing capability has an equivalent agent/MCP path and vice versa. Any UI action with no API/MCP tool (or an MCP tool with no UI surface where one is expected) is a parity FAIL.

## Phase 5 — Test architecture & build performance

> Goal: industry-leading coverage that runs *fast* on PRs. Speed comes from the affected graph and cache, not from skipping tests.

15. **Turborepo correctness (cache hygiene).** A cache hit is only safe if `inputs`/`outputs` are declared correctly. Audit `turbo.json`:
    - Every `test`, `build`, `lint`, `typecheck` task declares explicit `inputs` and `outputs`. Implicit-everything tasks → WARN (over-invalidates, kills cache).
    - `dependsOn` reflects real graph edges (`^build` before `build`, build before test where compiled output is tested).
    - `env` / `passThroughEnv` list every consumed env var. An undeclared env var that changes behavior is a **FAIL — cache poisoning risk** (stale artifact served for changed input).
    - No task writing outside its declared `outputs`; no `cache: false` on tasks that are actually deterministic.
    - Run `turbo run build --dry=json` and confirm the affected set for a trivial leaf change is *small*. A one-line change that invalidates the world signals a bad dependency edge.

16. **Remote cache, shared PR↔Vercel.** Confirm one remote cache backs both CI and Vercel so a PR build's artifacts are reused on deploy:
    - CI authenticates to the same remote cache (`TURBO_TOKEN` + `TURBO_TEAM`) as Vercel's Remote Cache. Two disconnected caches → WARN, you're paying twice and hitting cold builds on deploy.
    - Vercel build command is `turbo run build --filter=<app>` (not a bare `next build`) so it reads cache.
    - Measure hit rate: report cache-hit % from the last 5 PR runs and last 5 deploys. <70% hit on no-op-adjacent changes is a WARN with the likely cause (env churn, bad inputs, cache not shared).

17. **PR build time budget.** Report wall-clock for the affected `lint + typecheck + test + build` on the current PR. Set a budget (default 8 min); over budget is a WARN with the longest tasks and whether they cache-missed. Recommend concretely: split a slow package, parallelize Playwright shards, move a heavy integration test off the PR path to a nightly lane.

18. **Test lane separation.** Confirm tiers are wired so the PR path stays lean:
    - **PR lane:** affected unit + component + contract tests, fast.
    - **Pre-merge:** affected e2e (Playwright) sharded.
    - **Nightly / main:** full suite, full e2e matrix, coverage merge.
    A heavy e2e or integration suite running unconditionally on every PR is a WARN — gate it to affected or move it to pre-merge.

19. **E2e coverage of critical paths.** Independent of line coverage, verify Playwright covers the flows that matter: auth, tenant/workspace isolation, the MCP/agent parity surface from check 12, and billing. A critical flow with no e2e is a FAIL. Keep e2e focused on journeys; don't push unit-level assertions into slow browser tests.

## Phase 6 — Docs

20. **Stale docs.** Diff `CLAUDE.md` / `AGENTS.md` claims against current reality (paths, commands, stack, architecture). Flag stale lines for removal.

21. **Missing agent guidance.** Propose concrete additions to `CLAUDE.md` that would reduce agent thrash (conventions, gotchas, common commands, scoping rules). Show as a diff; do not commit without approval.

## Phase 7 — CI & PR hygiene

22. **CI on main.** `gh run list --branch main --limit 5`. Report green/red with failing-job links.

23. **Open PRs.** `gh pr list --state open`. For each PR:
    - Pull review threads from **Cursor**, **Greptile**, and human reviewers: `gh pr view <n> --json reviews,comments` plus review-thread API.
    - Confirm **every** comment has an inline reply tagged `fix`, `will not fix`, or `invalid feedback`. Any unaddressed thread → WARN and list it. **Do not fabricate replies** — surface unanswered ones for the human.
    - Report CI status per PR.

## Phase 8 — Actions (gated)

> Confirm with the user before executing this phase. Show the planned action list first.

24. **Mark ready.** For each open PR with **green CI and all review threads addressed**, mark ready: `gh pr ready <n>`. Skip drafts that still have open threads.

25. **Merge conflicts.** For PRs with conflicts, rebase onto `main` and resolve, **favoring the most recently changed code** (prefer the side with the newer commit timestamp on the conflicting hunk; when ambiguous, stop and ask). Never force-resolve a conflict touching migrations, RLS policies, or secrets without explicit sign-off.

26. **Deploy watch.** After a merge to `main`, monitor the Vercel + backend rollout: `gh run watch`, poll deploy status until production is live, and confirm CI stays green post-merge. If the deploy fails or CI goes red, **halt, do not retry blindly**, and report the failing stage with logs.

## Output

Write a self-contained HTML report (no external assets) to:

  docs/audits/release-audits/<SHORT_SHA>_<UTC_TIMESTAMP>_release-audit.html

where `SHORT_SHA` is `git rev-parse --short HEAD` captured in Phase 0, and
`UTC_TIMESTAMP` is the audit *request* time as `YYYYMMDDTHHMMSSZ`.
Example: docs/audits/release-audits/a1b9f3c_20260601T174500Z_release-audit.html

`mkdir -p docs/audits/release-audits` first. The report must contain, in order:
1. A header with repo, branch, full commit SHA, and request timestamp.
2. A **hero readiness band** — the single 0–100 composite grade in a large, bold,
   color-coded font, with a GO / NO-GO verdict pill and a PASS / WARN / FAIL badge.
3. A **score grid** of stat boxes — one box per required score (maintainability,
   security, SOC 2, GDPR, PCI, ops/CI, observability, end-user docs, internal docs,
   platform stability), each showing the number, a colored band, and confidence.
4. **Two maturity tables** — one row per `apps/*` directory and one row per
   `packages/*` project, each with its score, band, and one-line finding.
5. A summary table: check # · name · PASS/WARN/FAIL · one-line finding, color-coded.
6. **Blockers** (all FAILs) ranked by severity.
7. **Actions taken** (PRs marked ready, conflicts resolved, deploy result).
8. **Needs human** (unaddressed review threads, ambiguous conflicts, infra cost calls).
9. A **scoring methodology** footnote explaining the deduction model and bands.

Embed all CSS **and** the renderer JS inline so the file renders standalone when
opened from disk. **The template is data-driven:** you fill exactly one `DATA`
object and the inline renderer paints the hero, every stat box, both maturity
tables, the checks table, and the lists. **Do not hand-write rows** — push apps,
packages, scores, and checks into `DATA` arrays and let the renderer loop. Adding
an app or package later means adding one array entry (or, since the renderer just
loops, the Phase 0 enumeration can emit it programmatically); the template markup
never changes. Leave the `DATA` shape and the renderer intact.

### Output HTML Template

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TIMESTAMP}} · {{SHORT_SHA}} Release Audit</title>
<style>
  :root {
    --bg:#0B1020; --panel:rgba(255,255,255,.04); --border:rgba(255,255,255,.08);
    --fg:#E8EAF2; --muted:#9aa3b2;
    --pass:#3CFF52; --warn:#FFC53C; --fail:#FF5C7A;
    --good:#3CFF52; --fair:#9BE15D; --mid:#FFC53C; --poor:#FF9F45; --crit:#FF5C7A;
    --grad:linear-gradient(135deg,#7182FF,#3CFF52);
  }
  @media (prefers-color-scheme:light){
    :root{--bg:#F7F8FC;--panel:rgba(10,16,32,.03);--border:rgba(10,16,32,.10);--fg:#0B1020;--muted:#5a6478;}
  }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;padding:40px}
  .wrap{max-width:1120px;margin:0 auto}
  h1{font-size:24px;margin:0 0 4px} .sub{color:var(--muted);font-size:13px;margin-bottom:24px}
  .grad{height:3px;background:var(--grad);border-radius:3px;margin:18px 0 28px}
  h2{font-size:16px;margin:38px 0 14px}
  .meta{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted)}

  /* hero readiness band — big, bold, color-coded overall grade */
  .hero{display:flex;align-items:center;gap:30px;flex-wrap:wrap;
    background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:26px 32px}
  .hero .score{font-size:88px;font-weight:800;line-height:.95;letter-spacing:-.03em}
  .hero .score small{font-size:28px;font-weight:600;color:var(--muted);margin-left:4px}
  .hero .verdict{display:flex;flex-direction:column;gap:10px}
  .hero .pill{font-size:22px;font-weight:800;padding:8px 22px;border-radius:999px;
    letter-spacing:.02em;text-transform:uppercase}
  .hero .label{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
  .hero .badge{align-self:flex-start;font-size:14px;padding:5px 14px}

  /* score stat-box grid */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
  .stat{background:var(--panel);border:1px solid var(--border);border-radius:14px;
    padding:16px 18px;position:relative;overflow:hidden}
  .stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--bar,var(--muted))}
  .stat .name{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px}
  .stat .val{font-size:38px;font-weight:800;line-height:1}
  .stat .val small{font-size:15px;font-weight:600;color:var(--muted)}
  .stat .track{height:6px;border-radius:999px;background:rgba(127,127,127,.18);margin-top:12px;overflow:hidden}
  .stat .fill{height:100%;border-radius:999px}
  .stat .conf{font-size:11px;color:var(--muted);margin-top:8px;text-transform:uppercase;letter-spacing:.04em}

  table{width:100%;border-collapse:collapse;background:var(--panel);
    border:1px solid var(--border);border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:top}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  tr:last-child td{border-bottom:none}
  td.num{font-weight:800;font-size:18px;white-space:nowrap}
  .badge{font-weight:600;font-size:12px;padding:3px 9px;border-radius:999px;white-space:nowrap}
  .PASS{color:var(--pass);background:color-mix(in srgb,var(--pass) 14%,transparent)}
  .WARN{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
  .FAIL{color:var(--fail);background:color-mix(in srgb,var(--fail) 14%,transparent)}
  ul{margin:0;padding-left:20px} li{margin:4px 0}
  .foot{color:var(--muted);font-size:12px;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Oxagen Release Audit</h1>
  <div class="sub"><span class="meta" id="meta"></span><br><span id="reqAt"></span></div>
  <div class="grad"></div>

  <section id="hero"></section>

  <h2>Readiness scores</h2>
  <div class="grid" id="scores"></div>

  <h2>App maturity</h2>
  <table id="appsTbl"><thead><tr><th>App</th><th>Score</th><th>Band</th><th>Finding</th></tr></thead><tbody></tbody></table>

  <h2>Package maturity</h2>
  <table id="pkgsTbl"><thead><tr><th>Package</th><th>Score</th><th>Band</th><th>Finding</th></tr></thead><tbody></tbody></table>

  <h2>Checks</h2>
  <table id="checksTbl"><thead><tr><th>#</th><th>Check</th><th>Status</th><th>Finding</th></tr></thead><tbody></tbody></table>

  <h2>Blockers</h2><ul id="blockers"></ul>
  <h2>Actions taken</h2><ul id="actions"></ul>
  <h2>Needs human</h2><ul id="human"></ul>

  <p class="foot" id="method"></p>
</div>

<script>
/* ===========================================================================
 * Fill ONLY this DATA object. The renderer below paints everything from it.
 * apps / packages / scores / checks are arrays — add entries, never markup.
 * A new app or package = one more array item; the template never changes.
 * =========================================================================*/
const DATA = {
  repo: "{{REPO}}", branch: "{{BRANCH}}", sha: "{{FULL_SHA}}", requestedAt: "{{TIMESTAMP}}",
  composite: 0,                 // 0-100 overall release-readiness grade
  verdict: "NO-GO",             // "GO" | "NO-GO"
  status: "FAIL",               // overall "PASS" | "WARN" | "FAIL"
  // one stat box per required score; value 0-100; conf: "high"|"med"|"low"
  scores: [
    { name: "Maintainability",     value: 0, conf: "med" },
    { name: "Security",            value: 0, conf: "med" },
    { name: "SOC 2 compliance",    value: 0, conf: "med" },
    { name: "GDPR compliance",     value: 0, conf: "med" },
    { name: "PCI compliance",      value: 0, conf: "med" },
    { name: "Ops / CI maturity",   value: 0, conf: "med" },
    { name: "Observability",       value: 0, conf: "med" },
    { name: "Docs — end-user",     value: 0, conf: "med" },
    { name: "Docs — internal",     value: 0, conf: "med" },
    { name: "Platform stability",  value: 0, conf: "med" }
  ],
  // one row per apps/* dir enumerated in Phase 0 — generated, not hand-listed
  apps: [
    // { name: "app", value: 0, finding: "…" }
  ],
  // one row per packages/* project enumerated in Phase 0
  packages: [
    // { name: "ui", value: 0, finding: "…" }
  ],
  checks: [
    // { n: 1, name: "Overengineering", status: "PASS", finding: "…" }
  ],
  blockers: [],   // ["<strong>Name:</strong> detail", …]
  actions:  [],   // ["text", …]
  human:    []    // ["text", …]
};

/* band + color from a 0-100 value */
function band(v){
  if(v>=90) return {label:"Excellent", col:"var(--good)"};
  if(v>=75) return {label:"Good",      col:"var(--fair)"};
  if(v>=60) return {label:"Fair",      col:"var(--mid)"};
  if(v>=40) return {label:"Poor",      col:"var(--poor)"};
  return        {label:"Critical",  col:"var(--crit)"};
}
const el = (t,c,h)=>{const e=document.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e;};

/* header */
document.getElementById("meta").textContent = `${DATA.repo} · ${DATA.branch} · ${DATA.sha}`;
document.getElementById("reqAt").textContent = `Requested ${DATA.requestedAt}`;

/* hero — big bold colorful overall grade + verdict + PASS/WARN/FAIL */
(function(){
  const b = band(DATA.composite);
  const vcol = DATA.verdict==="GO" ? "var(--pass)" : "var(--fail)";
  document.getElementById("hero").innerHTML = `
    <div class="hero">
      <div>
        <div class="label">Release readiness</div>
        <div class="score" style="color:${b.col}">${DATA.composite}<small>/100</small></div>
      </div>
      <div class="verdict">
        <span class="pill" style="color:${vcol};background:color-mix(in srgb,${vcol} 16%,transparent)">${DATA.verdict}</span>
        <span class="badge ${DATA.status}">${DATA.status}</span>
        <span class="label">${b.label}</span>
      </div>
    </div>`;
})();

/* score stat boxes */
document.getElementById("scores").append(...DATA.scores.map(s=>{
  const b = band(s.value);
  const box = el("div","stat");
  box.style.setProperty("--bar", b.col);
  box.append(
    el("div","name", s.name),
    el("div","val", `${s.value}<small>/100</small>`),
    (()=>{const t=el("div","track"),f=el("div","fill"); f.style.width=s.value+"%"; f.style.background=b.col; t.append(f); return t;})(),
    el("div","conf", `${b.label} · confidence ${s.conf}`)
  );
  return box;
}));

/* maturity tables — apps and packages share one renderer */
function fillMaturity(tblId, rows){
  const tb = document.querySelector(`#${tblId} tbody`);
  if(!rows.length){ tb.append(el("tr",null,`<td colspan="4" style="color:var(--muted)">No projects found.</td>`)); return; }
  rows.forEach(r=>{
    const b = band(r.value);
    tb.append(el("tr",null,
      `<td><span class="meta">${r.name}</span></td>`+
      `<td class="num" style="color:${b.col}">${r.value}</td>`+
      `<td>${b.label}</td><td>${r.finding||""}</td>`));
  });
}
fillMaturity("appsTbl", DATA.apps);
fillMaturity("pkgsTbl", DATA.packages);

/* checks table */
(function(){
  const tb = document.querySelector("#checksTbl tbody");
  DATA.checks.forEach(c=> tb.append(el("tr",null,
    `<td>${c.n}</td><td>${c.name}</td>`+
    `<td><span class="badge ${c.status}">${c.status}</span></td><td>${c.finding||""}</td>`)));
})();

/* lists */
const li = (id,items,fallback)=>{
  const ul=document.getElementById(id);
  if(!items.length){ ul.append(el("li",null,`<span style="color:var(--muted)">${fallback}</span>`)); return; }
  items.forEach(t=> ul.append(el("li",null,t)));
};
li("blockers", DATA.blockers, "No blockers.");
li("actions",  DATA.actions,  "No actions taken.");
li("human",    DATA.human,    "Nothing pending.");

document.getElementById("method").textContent =
  "Scoring: each score starts at 100 and deducts per finding (FAIL −15…−25 by blast radius, WARN −5), floored at 0, with hard caps for blocker-class findings. Bands: ≥90 Excellent · 75–89 Good · 60–74 Fair · 40–59 Poor · <40 Critical. Composite is the severity-weighted roll-up; any unresolved blocker forces NO-GO.";
</script>
</body>
</html>
```

## Execution model

After Phase 0 completes, dispatch these audits **in parallel in a single turn** - issue all Task calls together, do not await one before starting the next:

- `code-architecture-auditor` → Phase 1
- `compliance-tenancy-auditor` → Phase 2
- `grep-auditor` → checks 2, 6 (secret scan), 8
- `test-build-auditor` → Phases 4–5
- `parity-docs-auditor` → check 12, Phase 6
- `pr-hygiene-auditor` → Phase 7

Wait for all to return, then synthesize their tables into the unified report.

**Phase 8 is serial and runs only after the report and explicit user confirmation** — never delegate gated mutations to a subagent.