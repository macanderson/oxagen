import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { OxagenIcon } from "@oxagen/ui";
import { HeroTerminal } from "@/components/landing/hero-terminal";
import { ContextWindow } from "@/components/landing/context-window";
import { CopyCommand } from "@/components/landing/copy-command";
import { HexField } from "@/components/ui/hex-field";

export const metadata: Metadata = {
  title: "Oxagen docs: the agent control plane",
  description:
    "Oxagen governs and operates the autonomous agents an enterprise runs: one mandate per agent, enforced on every call, and one fleet on one page. Docs for the CLI, the REST API, the MCP server, and Mission Control.",
};

/* What the control plane holds, mirrored from docs.oxagen.sh/docs. */
const FOUR_JOBS = [
  {
    title: "Wrap",
    body: "oxagen tacho enroll installs hooks in Claude Code and Codex on one machine. From then on every run there is recorded as a hash-chained sequence of frames and shipped to your workspace. The agent keeps working the way it works today.",
    href: "/docs/cli/desktop",
    cta: "Wrap a machine",
  },
  {
    title: "Govern",
    body: "Every agent holds an identity and a mandate, and nothing else. When a task needs a model call, a tool call, or a memory write, the agent asks through one invoke() boundary, and a rule you wrote answers: allowed, denied, or routed to a person. There is no second path.",
    href: "/docs/governance/overview",
    cta: "Roles and RBAC",
  },
  {
    title: "Record",
    body: "Every run leaves one record beside the data it touched: who started it, what the agent read, what it changed, and what it cost. The record lives in two audit stores, and one of them hash-chains every entry to the one before it.",
    href: "/docs/security/audit-logging",
    cta: "Audit logging",
  },
  {
    title: "Spend",
    body: "Every model call and tool call is priced by token class and attributed to an operator, an agent, a run, a turn, and a step. Hard ceilings per organization and workspace stop a run between steps, never mid-tool.",
    href: "/docs/billing",
    cta: "Billing and budgets",
  },
];

/* Quick links into the documentation set. */
const SURFACES = [
  {
    title: "Getting started",
    body: "Sign up, create your organization and workspace, wrap one machine.",
    href: "/docs/getting-started",
  },
  {
    title: "CLI",
    body: "Query the graph, cap spend, read a run, and manage credentials from the terminal. Stella runs the agent. Oxagen governs the run.",
    href: "/docs/cli",
  },
  {
    title: "REST API",
    body: "/v1 endpoints, API-key authentication, the capability registry, and the chat streaming transport.",
    href: "/docs/api/overview",
  },
  {
    title: "MCP server",
    body: "Reach /mcp over streamable HTTP. Your Oxagen API key carries the organization and workspace scope.",
    href: "/docs/mcp/overview",
  },
  {
    title: "In-app agent",
    body: "A governed turn loop over the fleet record and the knowledge graph: what your agents did, what context they had, what it cost, and what is waiting on a person.",
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
                The agent control plane
              </span>
            </span>

            <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              Run your agents <span className="lp-grad-text">as a fleet</span>.
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              Oxagen governs and operates the autonomous agents you run. Each
              agent works under one mandate, set by security, FinOps, and
              engineering, and enforced on every call. Every run is on the
              record with its cost. These docs cover the CLI, the REST API, the
              MCP server, and Mission Control, all behind one audited{" "}
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
                className="inline-flex h-11 items-center rounded-lg border border-border bg-card/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-b,#D4AF37)]/60"
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
            <span className="ox-eyebrow">The knowledge graph</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Never re-explain yourself{" "}
              <span className="lp-grad-text">to AI ever again</span>.
            </h2>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              Taught once, known by every agent you run. Oxagen hands the agent
              a typed knowledge graph at run time instead of training a model.
              Stuffing every document into the prompt saturates the window.
              Oxagen retrieves only the slice the task needs and the
              agent&apos;s mandate lets it read, so the window stays open and
              the model stays sharp.
            </p>
            <ul className="mt-7 space-y-3 text-sm">
              {[
                [
                  "Typed knowledge graph",
                  "Entities and relationships in Neo4j. Retrieval targets meaning, not a wall of text.",
                ],
                [
                  "Scoped by the mandate",
                  "The graph returns only what the agent's mandate lets it read, and the scope is checked on every query.",
                ],
                [
                  "Metered on every call",
                  "Every retrieval and model call records the context tokens it used, its latency, and the surface it came from.",
                ],
              ].map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--_ember-b,#D4AF37)]" />
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
              What the control plane holds.
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
              <div className="flex h-full flex-col rounded-xl border border-border p-6 transition-colors hover:border-[var(--_ember-b,#D4AF37)]/60 hover:bg-muted/40">
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
            Can you explain your AI bill?{" "}
            <span className="lp-grad-text">Neither can your provider</span>.
          </h2>
          <p className="mt-4 max-w-xl text-base text-muted-foreground">
            Install the CLI and wrap one machine, or read the getting-started
            guide to stand up an organization and workspace. The first screen
            shows your own numbers.
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
              className="inline-flex h-11 items-center rounded-lg border border-border bg-card/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-b,#D4AF37)]/60"
            >
              See your fleet
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
