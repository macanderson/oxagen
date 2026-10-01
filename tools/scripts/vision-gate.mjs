#!/usr/bin/env node
/**
 * vision-gate.mjs — LLM drift gate: judges a PR diff against docs/VISION.md.
 *
 * Answers one question per PR: does this change advance, stay neutral to, or
 * drift from the north-star positioning ("the control plane for every agent an
 * enterprise runs: a mandate set by the accountable teams, enforced on every
 * run")? The verdict is advisory — it posts a sticky PR comment + step summary and never fails the
 * build unless VISION_GATE_STRICT=1.
 *
 * It asks a second question of the same diff (#3202): does a doc or runbook in
 * the diff claim a control is on while the code leaves it off? A doc-drift
 * finding is a warning. It never fails the build, in strict mode or out of it.
 *
 * Usage:  pnpm check:vision                 (reads AI_GATEWAY_API_KEY)
 *         VISION_GATE_BASE=origin/main node tools/scripts/vision-gate.mjs
 *
 * Safe by design: missing AI_GATEWAY_API_KEY → no-op exit 0 (fork PRs and local
 * runs without the key don't error). Raw fetch instead of @oxagen/ai on purpose:
 * this runs in CI with no platform runtime (no ClickHouse to meter into) and
 * must not drag the workspace dependency graph into a 30-second advisory job.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const COMMENT_MARKER = "<!-- oxagen:vision-gate v1 -->";
export const MAX_DIFF_CHARS = 60_000;
/** The doc and runbook files' own budget, apart from {@link MAX_DIFF_CHARS}. */
export const MAX_DOC_DIFF_CHARS = 40_000;
export const VERDICTS = ["advances", "neutral", "drifts"];

const GATEWAY_ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/**
 * The doc-drift question (#3202). It is judged apart from the verdict, and its
 * answer is advisory only: a finding warns and never fails the build.
 */
export const DOC_DRIFT_QUESTION = [
  "=== DOC-DRIFT QUESTION (separate from the verdict) ===",
  "Does a doc or runbook in the diff claim a control is on while the code in",
  "the diff leaves it off? Read every changed file a person follows to run or",
  "judge the system: docs/capabilities/**, other Markdown, and operator",
  "guidance under infra/**, including comments in a Caddyfile, a Terraform",
  "template, or a deploy script. A control is a check, a limit, a refusal, a",
  "signature, an encryption, or an allow list. Report a claim when the doc says",
  "a setting turns the control on and the code reads a different setting,",
  "ignores the one named, or no longer has it, or when the doc says the control",
  "runs and the code skips or removed it. Each finding names the file, quotes",
  "the claim, and says what the code does instead. Report only what the diff",
  "shows. When nothing qualifies, or the diff changes no doc, return",
  '"doc_drift": []. A doc-drift finding does not change the verdict.',
  "The changed docs and runbooks are in the DOC AND RUNBOOK DIFF section,",
  "and the code they describe is in the DIFF section.",
].join("\n");

/** Paths whose churn says nothing about product direction. */
const DIFF_EXCLUDES = [
  ":!pnpm-lock.yaml",
  ":!**/pnpm-lock.yaml",
  ":!**/*.snap",
  ":!verifications/**",
];

function log(...a) {
  console.log("[vision-gate]", ...a);
}

/**
 * Whether a changed path is a doc or runbook the doc-drift question reads:
 * Markdown anywhere, everything under docs/, and operator guidance under
 * infra/.
 */
export function isDocPath(path) {
  return (
    /\.mdx?$/i.test(path) ||
    path.startsWith("docs/") ||
    path.startsWith("infra/")
  );
}

/**
 * Split a patch into its doc and runbook files and everything else, so each
 * part gets its own budget. On a large change the product files fill
 * {@link MAX_DIFF_CHARS} first, and the doc-drift question would read no doc
 * at all (Codex review on #4936).
 */
export function partitionDiff(patch) {
  const docs = [];
  const product = [];
  for (const file of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(\S+) b\//.exec(file);
    (header !== null && isDocPath(header[1]) ? docs : product).push(file);
  }
  return { product: product.join(""), docs: docs.join("") };
}

/** Truncate a patch to `limit` chars, noting how much was omitted. */
export function truncateDiff(patch, limit = MAX_DIFF_CHARS) {
  if (patch.length <= limit) return patch;
  const omitted = patch.length - limit;
  return `${patch.slice(0, limit)}\n\n[... diff truncated: ${omitted} characters omitted ...]`;
}

/**
 * Build the judge prompt. Kept pure so tests can pin the contract: the vision
 * doc is the ONLY rubric — the model must not invent its own strategy taste.
 */
export function buildPrompt(vision, pr, stat, patch) {
  const system = [
    "You are the Oxagen Vision Gate: a strict but fair reviewer that judges a",
    "pull request against the company's written product vision. The vision",
    "document below is your ONLY rubric — do not apply outside strategy",
    "opinions. Classify the change as exactly one of:",
    "",
    '- "advances": materially strengthens the control plane — lets an',
    "  accountable team set a clause of an agent's mandate (access, budget &",
    "  rules, equipment) or lets the platform enforce or record it (metering→",
    "  billing, contract governance, graph grounding, vendor neutrality, fleet",
    "  lineage, run evidence).",
    '- "neutral": routine engineering — bug fixes, refactors, tests, CI,',
    "  tooling, docs, performance, maintenance. Most PRs are neutral. Never",
    "  flag maintenance as drift.",
    '- "drifts": builds toward a future the vision declines (front-line',
    "  connector breadth / standalone evals / framework mindshare), or",
    "  violates wedge principles (unmetered or contract-bypassing capability,",
    "  ungrounded citation-free agent output where grounding applies,",
    "  vendor/cloud hard-coupling, lineage-free fan-out, or an agent runtime /",
    "  executor as a product surface — Oxagen governs agents, it does not run",
    "  them).",
    "",
    "Respond with ONLY a JSON object, no prose, no code fences:",
    "{",
    '  "verdict": "advances" | "neutral" | "drifts",',
    '  "confidence": <0..1>,',
    '  "summary": "<one sentence: what the change does and why the verdict>",',
    '  "reasons": ["<specific evidence from the diff>", ...],',
    '  "drift_flags": ["<only when drifting: which vision rule it breaks>", ...],',
    '  "recommendation": "<how to realign or deepen alignment, one sentence>",',
    '  "doc_drift": [{ "file": "<path>", "claim": "<what the doc says>", "code": "<what the code does>" }, ...]',
    "}",
    "",
    DOC_DRIFT_QUESTION,
    "",
    "=== VISION DOCUMENT (docs/VISION.md) ===",
    vision,
  ].join("\n");

  const { product, docs } = partitionDiff(patch);
  const user = [
    `PR title: ${pr.title || "(none)"}`,
    `PR description: ${pr.body || "(none)"}`,
    "",
    "=== DIFF STAT ===",
    stat,
    "",
    "=== DIFF ===",
    truncateDiff(product),
    "",
    "=== DOC AND RUNBOOK DIFF ===",
    docs
      ? truncateDiff(docs, MAX_DOC_DIFF_CHARS)
      : "(no doc or runbook changed)",
  ].join("\n");

  return { system, user };
}

/**
 * Parse the model's reply into a verdict object. Tolerates code fences and
 * surrounding prose; anything unparseable becomes an "inconclusive" verdict so
 * a flaky model reply can never crash CI or masquerade as a real judgement.
 */
export function parseVerdict(text) {
  const inconclusive = {
    verdict: "inconclusive",
    confidence: 0,
    summary: "The model reply could not be parsed as a verdict.",
    reasons: [],
    drift_flags: [],
    recommendation: "Re-run the gate or judge manually against docs/VISION.md.",
    doc_drift: [],
  };
  if (typeof text !== "string") return inconclusive;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return inconclusive;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!VERDICTS.includes(parsed.verdict)) return inconclusive;
    return {
      verdict: parsed.verdict,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.filter((r) => typeof r === "string")
        : [],
      drift_flags: Array.isArray(parsed.drift_flags)
        ? parsed.drift_flags.filter((r) => typeof r === "string")
        : [],
      recommendation:
        typeof parsed.recommendation === "string" ? parsed.recommendation : "",
      doc_drift: parseDocDrift(parsed.doc_drift),
    };
  } catch {
    return inconclusive;
  }
}

/**
 * The doc-drift findings in a reply, each `{ file, claim, code }`. A finding
 * with no claim is dropped, and anything that is not a list reads as none, so
 * a malformed answer can never invent a warning.
 */
export function parseDocDrift(raw) {
  if (!Array.isArray(raw)) return [];
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  return raw
    .filter((item) => item !== null && typeof item === "object")
    .map((item) => ({
      file: text(item.file),
      claim: text(item.claim),
      code: text(item.code),
    }))
    .filter((item) => item.claim !== "");
}

/** One line per finding, for the log and the annotation. */
export function docDriftLine(finding) {
  const where = finding.file === "" ? "" : `${finding.file}: `;
  const code = finding.code === "" ? "" : ` The code: ${finding.code}`;
  return `${where}${finding.claim}${code}`;
}

/**
 * A GitHub warning annotation for one finding. The workflow command ends at a
 * newline, so a newline in the text is escaped the way GitHub reads it back.
 */
export function docDriftAnnotation(finding) {
  const message = docDriftLine(finding)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::warning title=Vision Gate doc drift::${message}`;
}

const BADGE = {
  advances: "🟢 **Advances the vision**",
  neutral: "⚪ **Neutral** (routine engineering)",
  drifts: "🟠 **Drifts from the vision**",
  inconclusive: "⚠️ **Inconclusive** (model reply unparseable)",
};

/** Render the sticky PR comment. Always embeds COMMENT_MARKER for upserts. */
export function renderComment(v, model) {
  const lines = [
    COMMENT_MARKER,
    `### Vision Gate — ${BADGE[v.verdict] ?? v.verdict}`,
    "",
    v.summary,
  ];
  if (v.reasons.length) {
    lines.push("", "**Evidence:**", ...v.reasons.map((r) => `- ${r}`));
  }
  if (v.drift_flags.length) {
    lines.push(
      "",
      "**Vision rules touched:**",
      ...v.drift_flags.map((r) => `- ${r}`),
    );
  }
  if (v.recommendation) {
    lines.push("", `**Recommendation:** ${v.recommendation}`);
  }
  const docDrift = v.doc_drift ?? [];
  if (docDrift.length) {
    lines.push(
      "",
      "**Doc drift (advisory):** a doc or runbook in this diff claims a control is on while the code leaves it off. Link the setting's `ENV_REGISTRY` entry instead of naming what turns it on (AGENTS.md).",
      ...docDrift.map((f) => {
        const where = f.file === "" ? "" : `\`${f.file}\`: `;
        const code = f.code === "" ? "" : ` The code: ${f.code}`;
        return `- ${where}${f.claim}${code}`;
      }),
    );
  }
  lines.push(
    "",
    "---",
    `<sub>Advisory verdict from \`${model}\` judging this diff against [docs/VISION.md](../blob/main/docs/VISION.md) — the agent control plane north star. A drift verdict never blocks merge; it asks for a stated justification or a redirect. A doc-drift finding never blocks either. Confidence: ${v.confidence.toFixed(2)}.</sub>`,
  );
  return lines.join("\n");
}

/** Strict mode is the only way the gate can fail a build, and only on a drift verdict. Doc drift never fails it. */
export function shouldFail(v, strict) {
  return Boolean(strict) && v.verdict === "drifts";
}

function collectDiff(base) {
  const range = `${base}...HEAD`;
  const opts = { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 };
  const stat = execFileSync(
    "git",
    ["diff", "--stat", range, "--", ".", ...DIFF_EXCLUDES],
    opts,
  );
  const patch = execFileSync(
    "git",
    ["diff", range, "--", ".", ...DIFF_EXCLUDES],
    opts,
  );
  return { stat, patch };
}

async function callGateway(apiKey, model, prompt) {
  const res = await fetch(GATEWAY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 2000,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(
      `AI Gateway ${res.status}: ${(await res.text()).slice(0, 500)}`,
    );
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content ?? "";
}

async function upsertComment(repo, prNumber, token, body) {
  const api = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const existing = await fetch(`${api}?per_page=100`, { headers });
  if (existing.ok) {
    const comments = await existing.json();
    const mine = comments.find(
      (c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER),
    );
    if (mine) {
      const patch = await fetch(
        `https://api.github.com/repos/${repo}/issues/comments/${mine.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ body }),
        },
      );
      if (patch.ok) return "updated";
    }
  }
  const post = await fetch(api, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  return post.ok ? "created" : `failed (${post.status})`;
}

function readPrContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return { title: "", body: "", number: null };
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    const pr = event.pull_request;
    return pr
      ? {
          title: pr.title ?? "",
          body: pr.body ?? "",
          number: pr.number ?? null,
        }
      : { title: "", body: "", number: null };
  } catch {
    return { title: "", body: "", number: null };
  }
}

async function main() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    log("no AI_GATEWAY_API_KEY — skipping (no-op).");
    return;
  }
  const model = process.env.VISION_GATE_MODEL || DEFAULT_MODEL;
  const base = process.env.VISION_GATE_BASE || "origin/main";
  const vision = readFileSync(
    new URL("../../docs/VISION.md", import.meta.url),
    "utf8",
  );

  const { stat, patch } = collectDiff(base);
  if (!patch.trim()) {
    log(`no diff against ${base} — nothing to judge.`);
    return;
  }

  const pr = readPrContext();
  log(
    `judging ${stat.trim().split("\n").pop()?.trim() ?? "diff"} against docs/VISION.md via ${model}`,
  );
  const reply = await callGateway(
    apiKey,
    model,
    buildPrompt(vision, pr, stat, patch),
  );
  const verdict = parseVerdict(reply);
  const comment = renderComment(verdict, model);

  log(
    `verdict: ${verdict.verdict} (confidence ${verdict.confidence}) — ${verdict.summary}`,
  );
  for (const r of verdict.reasons) log(`  evidence: ${r}`);
  for (const f of verdict.drift_flags) log(`  drift flag: ${f}`);
  if (verdict.recommendation)
    log(`  recommendation: ${verdict.recommendation}`);
  for (const f of verdict.doc_drift) log(`  doc drift: ${docDriftLine(f)}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${comment}\n`);
  }
  if (verdict.verdict === "drifts") {
    // GitHub annotation — surfaces on the PR checks tab even without a comment.
    console.log(`::warning title=Vision Gate::${verdict.summary}`);
  }
  // Doc drift warns on the checks tab too, and never sets the exit code.
  for (const f of verdict.doc_drift) console.log(docDriftAnnotation(f));

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (token && repo && pr.number) {
    const result = await upsertComment(repo, pr.number, token, comment);
    log(`PR comment ${result}.`);
  } else {
    log("no GITHUB_TOKEN/GITHUB_REPOSITORY/PR number — printed verdict only.");
  }

  if (shouldFail(verdict, process.env.VISION_GATE_STRICT === "1")) {
    log("VISION_GATE_STRICT=1 and verdict is drifts — failing.");
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    // Advisory gate: an infra failure (gateway down, no credit, API hiccup)
    // must not block merges — but a drift gate that skips silently hides its
    // own outage, so surface the skip in the step summary and as a warning
    // annotation before exiting 0 (unless strict mode demands otherwise).
    console.error("[vision-gate] error:", err);
    const notice = `### Vision Gate — ⚠️ **Skipped** (infrastructure error)\n\nThe drift check did not run: \`${String(err?.message ?? err).slice(0, 300)}\`\n`;
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, notice);
    }
    console.log(
      `::warning title=Vision Gate skipped::${String(err?.message ?? err).slice(0, 300)}`,
    );
    if (process.env.VISION_GATE_STRICT === "1") process.exitCode = 1;
  });
}
