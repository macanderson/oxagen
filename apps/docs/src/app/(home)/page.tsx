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
    "Oxagen governs the agents an enterprise runs, autonomous and supervised alike: one mandate per agent, checked on the calls routed through Oxagen, and one fleet on one page. Docs for the CLI, the REST API, the MCP server, and the operator console.",
};

/* What the control plane holds, mirrored from docs.oxagen.sh/docs. */
const FOUR_JOBS = [
  {
    title: "Wrap",
    body: "Enroll the machine that runs your agent. Harness hooks send recorded steps to your workspace. Hook-based evidence is client-attested, and observe mode records activity without enforcing it.",
    href: "/docs/cli/wrap-an-agent",
    cta: "Wrap a machine",
  },
  {
    title: "Govern",
    body: "Give each agent an identity and a mandate. For actions routed through Oxagen, the control plane checks its authority and records the decision. Credentials for mediated connections stay in Oxagen.",
    href: "/docs/governance/overview",
    cta: "Roles and RBAC",
  },
  {
    title: "Record",
    body: "Inspect recorded steps, decisions, and cost on a run. Query security events in Postgres and IAM decisions in ClickHouse. The audit guide explains what each store records and where evidence can be missing.",
    href: "/docs/security/audit-logging",
    cta: "Audit logging",
  },
  {
    title: "Spend",
    body: "Review recorded usage by agent, operator, workspace, and run. Set organization and workspace ceilings for governed consumption. Check whether each cost was measured, reported, or estimated.",
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
    body: "Browse the plugin catalog through API or MCP. Inspect installation, credential, entitlement, and role requirements.",
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
              Workforce management for{" "}
              <span className="lp-grad-text">autonomous agents</span>.
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              Set each agent&apos;s identity, authority, budget, tools, and
              skills. Inspect its recorded work in Oxagen. These docs cover the
              CLI, REST API, and MCP surfaces whose capability calls pass
              through the{" "}
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
              Give agents the business context{" "}
              <span className="lp-grad-text">their work requires</span>.
            </h2>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              Request workspace entities, relationships, and memories through
              scoped retrieval capabilities. Choose context relevant to the task
              within the agent&apos;s permitted scope and context budget.
            </p>
            <ul className="mt-7 space-y-3 text-sm">
              {[
                [
                  "Typed knowledge graph",
                  "Search entities and relationships stored in Neo4j.",
                ],
                [
                  "Scoped by the mandate",
                  "Governed graph reads check the caller's authority and workspace scope.",
                ],
                [
                  "Recorded usage",
                  "Inspect the usage and timing recorded for the retrieval and model calls your agent makes.",
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
            Choose an interface.
          </h2>
          <p className="mt-4 text-base text-muted-foreground">
            Each capability declares which surfaces expose it. Read its contract
            and the interface guide before connecting your client.
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
            See which agent spent what,{" "}
            <span className="lp-grad-text">and on whose behalf</span>.
          </h2>
          <p className="mt-4 max-w-xl text-base text-muted-foreground">
            Install the CLI and wrap one machine, or read the getting-started
            guide to create an organization and workspace. Run a task in the
            wrapped harness, then inspect the record that arrived.
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
