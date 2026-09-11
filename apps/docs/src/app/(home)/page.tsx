import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { OxagenIcon } from "@oxagen/ui";
import { HeroTerminal } from "@/components/landing/hero-terminal";
import { ContextWindow } from "@/components/landing/context-window";
import { CopyCommand } from "@/components/landing/copy-command";
import { HexField } from "@/components/ui/hex-field";

export const metadata: Metadata = {
  title: "Oxagen Docs — the governed control plane for AI agents",
  description:
    "Oxagen teaches every agent your team runs — Stella, or your own — your business, governs what it may do, explains every run, and learns from each one. Docs for the API, MCP server, CLI, and in-app agent.",
};

/* The four jobs, mirrored from oxagen.sh and docs.oxagen.sh/docs. */
const FOUR_JOBS = [
  {
    title: "Teach",
    body: "Oxagen gives every agent your company's knowledge and rules at run time, from a typed knowledge graph — not by training a model. The agent starts each job already knowing your customers, your code, and how you work.",
    href: "/docs/knowledge",
    cta: "The knowledge graph",
  },
  {
    title: "Govern",
    body: "Every agent gets an identity, a role, and a budget. Every action — model call, tool invocation, code execution, memory write — passes a single invoke() kernel boundary that checks it against those before it runs. There is no alternate path.",
    href: "/docs/governance/overview",
    cta: "Roles and RBAC",
  },
  {
    title: "Explain",
    body: "Every run is saved as a trace next to the data it touched: who asked, what the agent read, what it changed, what proved it, and what it cost.",
    href: "/docs/security/audit-logging",
    cta: "Audit logging",
  },
  {
    title: "Learn",
    body: "Proven runs write skills, tools, and tuned settings back to the graph the next run starts with. Over time, the proven runs can train a model you own.",
    href: "/docs/agent/memory",
    cta: "Agent memory",
  },
];

/* Quick links into the documentation set. */
const SURFACES = [
  {
    title: "Getting started",
    body: "Sign up, create your organization and workspace, send your first message.",
    href: "/docs/getting-started",
  },
  {
    title: "CLI",
    body: "Install the oxagen CLI to govern, ground, explain, meter, and rate your agents from the terminal — Stella runs them, Oxagen governs the run.",
    href: "/docs/cli",
  },
  {
    title: "REST API",
    body: "/v1 endpoints, API-key authentication, the capability registry, and the chat streaming transport.",
    href: "/docs/api/overview",
  },
  {
    title: "MCP server",
    body: "Connect at /mcp over streamable HTTP; org + workspace scope carried by your API key.",
    href: "/docs/mcp/overview",
  },
  {
    title: "In-app agent",
    body: "A governed turn loop over the fleet record and the knowledge graph — what your agents did, what context they had, what it cost, what is pending approval.",
    href: "/docs/agent/overview",
  },
  {
    title: "Plugins",
    body: "Capability packs, the static registry, tiers and entitlement gating, and the workspace marketplace.",
    href: "/docs/plugins/overview",
  },
];

const APP_URL = "https://app.oxagen.sh";

/**
 * The one command the docs actually recommend. Kept identical to the /install
 * page and the floating InstallCliButton: a global npm install of @oxagen/cli
 * is not reliably standalone yet (see /docs/cli/installation), so the landing
 * CTAs must not advertise one.
 */
const INSTALL_CMD = "curl -fsSL https://cli.oxagen.sh/install.sh | sh";

export default function HomePage(): ReactNode {
  return (
    <div className="flex flex-col">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border">
        {/* layered background: ambient grid + ember orb + hex constellation */}
        <div
          aria-hidden="true"
          className="lp-grid pointer-events-none absolute inset-0 -z-10"
        />
        <div
          aria-hidden="true"
          className="lp-orb pointer-events-none absolute left-1/2 top-[-12%] -z-10 h-[520px] w-[820px] -translate-x-1/2"
        />
        <HexField className="lp-float pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-70" />

        <div className="relative z-10 mx-auto grid w-full max-w-7xl items-center gap-12 px-6 py-20 lg:grid-cols-[1.05fr_1fr] lg:py-28">
          <div className="flex flex-col items-start text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
              <span className="ox-eyebrow !text-[11px] !tracking-[0.14em]">
                Teach. Govern. Explain. Learn.
              </span>
            </span>

            <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              The governed control plane{" "}
              <span className="lp-grad-text">for AI agents</span>.
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              Oxagen teaches every agent your team runs — Stella, or your own —
              your business, governs what it{"'"}s allowed to know and do,
              explains every run in one trace, and learns from the ones that
              pass. These docs cover the API, MCP server, CLI, and in-app agent
              that make up the control plane — all through one audited{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                invoke()
              </code>{" "}
              boundary.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/docs/getting-started"
                className="lp-grad-surface inline-flex h-11 items-center rounded-lg px-6 text-sm font-semibold text-ink-dark shadow-sm transition-transform hover:scale-[1.02] active:scale-100"
              >
                Get started
              </Link>
              <Link
                href="/docs"
                className="inline-flex h-11 items-center rounded-lg border border-border bg-card/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-b,#D6962C)]/60"
              >
                Read the docs
              </Link>
            </div>

            <div className="mt-6">
              <CopyCommand command={INSTALL_CMD} />
            </div>
          </div>

          {/* animated install terminal */}
          <div className="relative w-full">
            <HeroTerminal />
          </div>
        </div>
      </section>

      {/* ── Context window: more free than full ───────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border bg-muted/20">
        <HexField className="pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-40" />
        <div className="relative z-10 mx-auto grid w-full max-w-7xl items-center gap-12 px-6 py-20 lg:grid-cols-[1fr_1.1fr] lg:py-28">
          <div>
            <span className="ox-eyebrow">How Teach works</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              A graph, not a <span className="lp-grad-text">fine-tune</span>.
            </h2>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              Teaching an agent your business does not mean training a model —
              it means handing the agent a typed knowledge graph at run time.
              The naive pattern stuffs every document into the prompt until the
              window saturates; Oxagen retrieves only the precise, authorized
              slice the task needs, so the window stays open and the model stays
              sharp.
            </p>
            <ul className="mt-7 space-y-3 text-sm">
              {[
                [
                  "Typed knowledge graph",
                  "Entities and relationships in Neo4j — retrieval targets meaning, not a wall of text.",
                ],
                [
                  "RBAC-scoped retrieval",
                  "The graph only returns what the caller is authorized to see; isolation is enforced, not hoped for.",
                ],
                [
                  "Metered + instrumented",
                  "Every retrieval and model call records context tokens used, latency, and surface of origin.",
                ],
              ].map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--_ember-b,#D6962C)]" />
                  <span>
                    <span className="font-medium text-foreground">{t}.</span>{" "}
                    <span className="text-muted-foreground">{d}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-border bg-card/70 p-6 backdrop-blur sm:p-8">
            <ContextWindow />
          </div>
        </div>
      </section>

      {/* ── Four jobs ──────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border">
        <div className="relative mx-auto w-full max-w-7xl px-6 py-20 lg:py-28">
          <div className="max-w-2xl">
            <span className="ox-eyebrow">The platform</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Four jobs. One platform. One loop.
            </h2>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2">
            {FOUR_JOBS.map((p) => (
              <div
                key={p.title}
                className="group relative flex flex-col bg-background p-7 sm:p-8"
              >
                <HexField className="pointer-events-none absolute inset-0 h-full w-full text-foreground opacity-0 transition-opacity duration-500 group-hover:opacity-30" />
                <h3 className="relative text-lg font-semibold text-foreground">
                  {p.title}
                </h3>
                <p className="relative mt-3 flex-1 text-sm text-muted-foreground">
                  {p.body}
                </p>
                <Link
                  href={p.href}
                  className="relative mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--ember-ink)] hover:underline"
                >
                  {p.cta}
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 12h14m-6-6 6 6-6 6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Documentation surfaces ────────────────────────────────────────── */}
      <section className="relative mx-auto w-full max-w-7xl px-6 py-20 lg:py-24">
        <div className="max-w-2xl">
          <span className="ox-eyebrow">Documentation</span>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Everything is reachable three ways.
          </h2>
          <p className="mt-4 text-base text-muted-foreground">
            One capability model, exposed identically across the REST API, the
            MCP server, and the in-app agent. Pick a surface and start building.
          </p>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {SURFACES.map((s) => (
            <Link key={s.href} href={s.href} className="group">
              <div className="flex h-full flex-col rounded-xl border border-border p-6 transition-colors hover:border-[var(--_ember-b,#D6962C)]/60 hover:bg-muted/40">
                <h3 className="text-base font-semibold text-foreground group-hover:text-[var(--ember-ink)]">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-t border-border bg-muted/20">
        <div
          aria-hidden="true"
          className="lp-orb pointer-events-none absolute bottom-[-40%] left-1/2 -z-10 h-[480px] w-[760px] -translate-x-1/2 opacity-60"
        />
        <HexField className="pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-40" />
        <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-24 text-center">
          <OxagenIcon className="size-12" />
          <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            Start <span className="lp-grad-text">teaching</span> your agents.
          </h2>
          <p className="mt-4 max-w-xl text-base text-muted-foreground">
            Install the CLI and ask your codebase a question, or read the
            getting-started guide to stand up an organization and workspace.
          </p>
          <div className="mt-8">
            <CopyCommand command={INSTALL_CMD} />
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/docs/getting-started"
              className="lp-grad-surface inline-flex h-11 items-center rounded-lg px-6 text-sm font-semibold text-ink-dark shadow-sm transition-transform hover:scale-[1.02] active:scale-100"
            >
              Get started
            </Link>
            <a
              href={APP_URL}
              className="inline-flex h-11 items-center rounded-lg border border-border bg-card/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-b,#D6962C)]/60"
            >
              Open Oxagen
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
