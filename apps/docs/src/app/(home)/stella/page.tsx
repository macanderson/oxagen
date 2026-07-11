import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { CopyCommand } from "@/components/landing/copy-command";
import { StellaLogomark } from "@/components/landing/stella-logomark";
import { StellaTerminal } from "@/components/landing/stella-terminal";
import { HexField } from "@/components/ui/hex-field";

export const metadata: Metadata = {
  title: "Stella — the open-source coding agent that proves it's done",
  description:
    "Stella is a fast, BYOK, model-agnostic terminal coding agent written in Rust, from the makers of Oxagen. Bring a key from any of nine providers or run a local model, set a hard dollar budget, and ship work verified by a witness test, not by the agent's word.",
};

const REPO_URL = "https://github.com/oxageninc/stella-cli";
const INSTALL_CMD = "cargo install --locked --git https://github.com/oxageninc/stella-cli stella-cli";

/* Every provider Stella auto-detects, mirrored from the README key table. */
const PROVIDERS = [
  { name: "Anthropic", env: "ANTHROPIC_API_KEY", model: "claude-fable-5" },
  { name: "OpenAI", env: "OPENAI_API_KEY", model: "gpt-5.5" },
  { name: "Google Gemini", env: "GEMINI_API_KEY", model: "gemini-3-pro" },
  { name: "Google Vertex AI", env: "VERTEX_ACCESS_TOKEN", model: "gemini-3-pro" },
  { name: "Amazon Bedrock", env: "AWS_ACCESS_KEY_ID", model: "claude on Converse" },
  { name: "xAI", env: "XAI_API_KEY", model: "grok-4" },
  { name: "DeepSeek", env: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  { name: "Z.ai", env: "ZAI_API_KEY", model: "glm-5.2" },
  { name: "OpenRouter", env: "OPENROUTER_API_KEY", model: "auto" },
  { name: "Local", env: "--base-url, no key", model: "Ollama, vLLM, LM Studio" },
];

/* What ships in the box — each claim traceable to the README and CLI surface. */
const FEATURES = [
  {
    title: "Judged goal mode",
    body: "stella goal works in rounds. After each round an LLM judge checks the goal with its own read-only tools (read_file, grep, ci_status), and its feedback drives the next round. It stops when the evidence says done, bounded by a round cap and your budget.",
  },
  {
    title: "A hard dollar budget",
    body: "--budget 5 is a promise, not a suggestion. Stella meters every call against the model card's pricing and aborts cleanly (never mid-tool) once total spend crosses the line. Omit it and spend is still metered for the cost summary.",
  },
  {
    title: "Parallel tools",
    body: "Independent tool calls run concurrently. Reads, searches, and builds overlap instead of queuing, so a step that fans out across the codebase finishes in one round trip.",
  },
  {
    title: "Local-first telemetry",
    body: "Every execution is recorded in .stella/stella.duckdb on your disk: the full event stream, per-call tokens and cost, and the files-touched ledger. Query it with any DuckDB client. It is your data.",
  },
  {
    title: "Self-improving memories",
    body: "Lessons saved with save_memory, or written by you as markdown in .stella/memories/, load once at session start into a byte-stable system prompt. Every call reads them at prompt-cache-hit prices.",
  },
  {
    title: "CI to green",
    body: "stella monitor main watches CI for a branch or PR through gh, reads the failure logs, and fixes until the run is fully green, judged like any other goal. Issue tools for Linear and GitHub load only when configured.",
  },
];

/* The workspace crates, mirrored from the repo's architecture section. */
const CRATES = [
  ["stella-cli", "the stella binary: agent loop, REPL, TUI"],
  ["stella-core", "step-driver engine: parallel tools, goal loop, budget, retry, compaction"],
  ["stella-tools", "the built-in tools: file CRUD, exec, verify_done, issues, CI"],
  ["stella-model", "provider adapters: SSE streaming, tool-call dialects, pricing"],
  ["stella-store", "DuckDB persistence: executions, events, telemetry, locks"],
  ["stella-protocol", "versioned serde types shared across every boundary"],
  ["ocp-types", "Open Context Protocol wire types"],
];

/* Stella's official brand palette (crates/site brand assets: accent #FFAC26).
   The landing lp-* classes read the --_ember-* custom properties, so scoping
   the override here re-skins every gradient, orb, and caret on this page only. */
const STELLA_BRAND = {
  "--_ember-gold": "#ffc763",
  "--_ember-flame": "#ffac26",
  "--_ember-crimson": "#e08700",
} as CSSProperties;

export default function StellaPage(): ReactNode {
  return (
    <div className="flex flex-col" style={STELLA_BRAND}>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border">
        <div aria-hidden="true" className="lp-grid pointer-events-none absolute inset-0 -z-10" />
        <div aria-hidden="true" className="lp-orb pointer-events-none absolute left-1/2 top-[-12%] -z-10 h-[520px] w-[820px] -translate-x-1/2" />
        <HexField className="lp-float pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-70" />

        <div className="relative z-10 mx-auto grid w-full max-w-7xl items-center gap-12 px-6 py-20 lg:grid-cols-[1.05fr_1fr] lg:py-28">
          <div className="flex flex-col items-start text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
              <StellaLogomark className="size-3.5 text-foreground" />
              <span className="ox-eyebrow !text-[11px] !tracking-[0.14em]">Stella · open source · from the makers of Oxagen</span>
            </span>

            <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              The coding agent that <span className="lp-grad-text">proves</span> it&apos;s done.
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              Coding agents love to declare victory. Stella has to earn it: a witness test that fails on
              your old code and passes on the new, checked by a judge with its own tools. It runs in your
              terminal, it is written in Rust, and it works with{" "}
              <span className="text-foreground">your key, any of nine providers, or a local model</span>.
              No account. No phone-home.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/docs/stella"
                className="lp-grad-surface inline-flex h-11 items-center rounded-lg px-6 text-sm font-semibold text-[#1a1406] shadow-sm transition-transform hover:scale-[1.02] active:scale-100"
              >
                Get started
              </Link>
              <a
                href={REPO_URL}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-card/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-flame,#F07650)]/60"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 .5A11.5 11.5 0 0 0 .5 12.3c0 5.22 3.3 9.65 7.86 11.21.58.11.79-.26.79-.57v-2c-3.2.71-3.87-1.58-3.87-1.58-.53-1.37-1.28-1.74-1.28-1.74-1.05-.74.08-.72.08-.72 1.16.08 1.77 1.22 1.77 1.22 1.03 1.81 2.7 1.29 3.36.98.1-.77.4-1.29.73-1.58-2.55-.3-5.23-1.31-5.23-5.83 0-1.29.45-2.34 1.19-3.17-.12-.3-.52-1.51.11-3.14 0 0 .97-.32 3.17 1.21a10.7 10.7 0 0 1 5.78 0c2.2-1.53 3.17-1.21 3.17-1.21.63 1.63.23 2.84.11 3.14.74.83 1.19 1.88 1.19 3.17 0 4.53-2.69 5.52-5.25 5.81.41.37.78 1.08.78 2.18v3.23c0 .31.2.69.8.57A11.8 11.8 0 0 0 23.5 12.3 11.5 11.5 0 0 0 12 .5Z" />
                </svg>
                View on GitHub
              </a>
            </div>

            <div className="mt-6">
              <CopyCommand command={INSTALL_CMD} />
            </div>
          </div>

          {/* animated goal-mode terminal */}
          <div className="relative w-full">
            <StellaTerminal />
          </div>
        </div>
      </section>

      {/* ── The witness gate ──────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border bg-muted/20">
        <HexField className="pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-40" />
        <div className="relative z-10 mx-auto grid w-full max-w-7xl items-center gap-12 px-6 py-20 lg:grid-cols-[1fr_1.1fr] lg:py-28">
          <div>
            <span className="ox-eyebrow">The definition of done</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              A green suite is <span className="lp-grad-text">not proof</span>.
            </h2>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              A test suite can pass because the feature works, or because the tests never touched it.
              Stella works test-first and holds itself to a harder gate: the{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">verify_done</code>{" "}
              tool replays the witness test against your previous code in a shadow worktree.
            </p>
            <ul className="mt-7 space-y-3 text-sm">
              {[
                ["Fails on the old code", "The witness test runs against git HEAD with only the new test files layered in. If it passes there, it never witnessed the change."],
                ["Passes on the new code", "The same test then runs against the working tree. Red-to-green across the boundary is the only accepted evidence."],
                ["Judged, not self-graded", "In goal mode an LLM judge re-checks the claim with its own read-only tools before Stella is allowed to stop."],
              ].map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--_ember-flame,#F07650)]" />
                  <span>
                    <span className="font-medium text-foreground">{t}.</span>{" "}
                    <span className="text-muted-foreground">{d}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* static witness-gate transcript */}
          <div className="rounded-2xl border border-border bg-card/70 p-6 backdrop-blur sm:p-8">
            <p className="ox-eyebrow">verify_done</p>
            <div className="mt-4 space-y-2 overflow-x-auto rounded-lg border border-border bg-muted/60 p-4 font-mono text-xs leading-relaxed text-foreground">
              <div><span className="select-none text-[var(--_ember-flame,#F07650)]">→</span> shadow worktree at git HEAD + new test files</div>
              <div className="pl-4 text-muted-foreground">running tests/crlf_test.rs … <span className="text-[#e5484d]">FAILED</span> (expected: the old code cannot pass)</div>
              <div><span className="select-none text-[var(--_ember-flame,#F07650)]">→</span> working tree with your change</div>
              <div className="pl-4 text-muted-foreground">running tests/crlf_test.rs … <span className="text-[#38d39f]">ok</span></div>
              <div className="pt-1 font-semibold text-[#38d39f]">WITNESS CONFIRMED</div>
              <div className="text-muted-foreground">a merely green suite is not accepted as done</div>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Green suites can hide unwired features and vacuous tests. The witness cannot.
            </p>
          </div>
        </div>
      </section>

      {/* ── BYOK providers ────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border">
        <div className="relative mx-auto w-full max-w-7xl px-6 py-20 lg:py-28">
          <div className="max-w-2xl">
            <span className="ox-eyebrow">Bring your own key</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Any model. Your key. <span className="lp-grad-text">No account.</span>
            </h2>
            <p className="mt-4 text-base text-muted-foreground">
              Export a key and Stella detects the provider. Pin one with{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">--model provider/model</code>, or
              point <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">--base-url</code> at any
              OpenAI-compatible server and skip the key entirely. The only network traffic is to the
              provider you chose.
            </p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
            {PROVIDERS.map((p) => (
              <div key={p.name} className="group relative flex flex-col bg-background p-5">
                <HexField className="pointer-events-none absolute inset-0 h-full w-full text-foreground opacity-0 transition-opacity duration-500 group-hover:opacity-30" />
                <h3 className="relative text-sm font-semibold text-foreground">{p.name}</h3>
                <p className="relative mt-2 font-mono text-[11px] text-muted-foreground">{p.env}</p>
                <p className="relative mt-1 font-mono text-[11px] text-[var(--_ember-flame,#F07650)]">{p.model}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Vertex AI and Bedrock use your existing cloud credentials. Gateways like Vercel AI Gateway,
            Azure OpenAI, and Together work through <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">--base-url</code> the
            same way local servers do.
          </p>
        </div>
      </section>

      {/* ── Feature grid ──────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border bg-muted/20">
        <HexField className="pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-40" />
        <div className="relative z-10 mx-auto w-full max-w-7xl px-6 py-20 lg:py-28">
          <div className="max-w-2xl">
            <span className="ox-eyebrow">What ships in the box</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Built for long runs you don&apos;t babysit.
            </h2>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="group relative flex flex-col bg-background p-7">
                <HexField className="pointer-events-none absolute inset-0 h-full w-full text-foreground opacity-0 transition-opacity duration-500 group-hover:opacity-30" />
                <h3 className="relative text-lg font-semibold text-foreground">{f.title}</h3>
                <p className="relative mt-3 flex-1 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Open source / architecture ────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border">
        <div className="relative mx-auto grid w-full max-w-7xl items-center gap-12 px-6 py-20 lg:grid-cols-[1fr_1.1fr] lg:py-28">
          <div>
            <span className="ox-eyebrow">Open source</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              MIT or Apache-2.0. <span className="lp-grad-text">Built in the open.</span>
            </h2>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              Stella is developed in public at{" "}
              <a href={REPO_URL} className="font-medium text-[var(--_ember-flame,#F07650)] hover:underline">
                oxageninc/stella-cli
              </a>{" "}
              by the team behind{" "}
              <Link href="/" className="font-medium text-foreground hover:underline">
                Oxagen
              </Link>
              , the governed control plane for AI agents. Stella stands alone: no Oxagen account, no
              platform dependency, one Rust workspace of seven crates driven through traits, not
              concretions.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href={REPO_URL}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card/60 px-5 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-flame,#F07650)]/60"
              >
                Star the repo
              </a>
              <a
                href={`${REPO_URL}/blob/main/CONTRIBUTING.md`}
                className="inline-flex h-10 items-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Contributing guide
              </a>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card/70 p-6 backdrop-blur sm:p-8">
            <p className="ox-eyebrow">The workspace</p>
            <ul className="mt-4 space-y-2.5 font-mono text-xs leading-relaxed">
              {CRATES.map(([name, desc]) => (
                <li key={name} className="flex flex-wrap gap-x-3">
                  <span className="min-w-[8.5rem] font-semibold text-[var(--_ember-flame,#F07650)]">{name}</span>
                  <span className="flex-1 text-muted-foreground">{desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden bg-muted/20">
        <div aria-hidden="true" className="lp-orb pointer-events-none absolute bottom-[-40%] left-1/2 -z-10 h-[480px] w-[760px] -translate-x-1/2 opacity-60" />
        <HexField className="pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-40" />
        <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-24 text-center">
          <StellaLogomark className="size-12 text-foreground" />
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            Point it at a bug <span className="lp-grad-text">tonight</span>.
          </h2>
          <p className="mt-4 max-w-xl text-base text-muted-foreground">
            One cargo command, one exported key, and Stella is working in your repo. The getting-started
            guide covers install, providers, and your first judged goal.
          </p>
          <div className="mt-8">
            <CopyCommand command={INSTALL_CMD} />
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/docs/stella"
              className="lp-grad-surface inline-flex h-11 items-center rounded-lg px-6 text-sm font-semibold text-[#1a1406] shadow-sm transition-transform hover:scale-[1.02] active:scale-100"
            >
              Get started
            </Link>
            <a
              href={REPO_URL}
              className="inline-flex h-11 items-center rounded-lg border border-border bg-card/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-flame,#F07650)]/60"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
