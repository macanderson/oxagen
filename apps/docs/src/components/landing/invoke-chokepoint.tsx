import type { ReactNode } from "react";

/**
 * InvokeChokepoint — the landing hero's visual argument: every capability,
 * whatever surface it arrived on, funnels through one `invoke()` boundary that
 * authorizes, meters, and records it before a handler ever runs.
 *
 * Deliberately static markup (no client JS, no timers): the page's claim is
 * that the path is fixed, so the illustration is fixed too. Colours come from
 * the shared brand tokens, so it re-skins with the rest of the system in both
 * light and dark mode.
 */

const SURFACES = ["REST API", "MCP server", "In-app agent"];

const GATES = [
  { label: "Authorize", detail: "IAM · default-deny · org + workspace scope" },
  { label: "Meter", detail: "credits, tokens, latency — per call" },
  { label: "Record", detail: "immutable audit event, tamper-evident" },
];

const LEDGER = [
  {
    verdict: "allowed",
    actor: "agent/ci-fixer",
    action: "opened a pull request",
  },
  {
    verdict: "allowed",
    actor: "team/payments",
    action: "2 models · 14 tool calls",
  },
  { verdict: "denied", actor: "agent/intern", action: "delete outside policy" },
];

function Connector(): ReactNode {
  return (
    <div
      aria-hidden="true"
      className="mx-auto h-6 w-px bg-gradient-to-b from-border to-[var(--_ember-flame,#FF7E5F)]/60"
    />
  );
}

export function InvokeChokepoint(): ReactNode {
  return (
    <div className="rounded-2xl border border-border bg-card/70 p-6 backdrop-blur sm:p-8">
      <div className="flex items-center justify-between gap-3">
        <span className="ox-eyebrow !text-[11px] !tracking-[0.14em]">
          One path in
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          policy: enforced
        </span>
      </div>

      {/* Surfaces — three doors, one boundary. */}
      <div className="mt-5 grid grid-cols-3 gap-2">
        {SURFACES.map((s) => (
          <div
            key={s}
            className="rounded-lg border border-border bg-background px-2 py-2 text-center text-[11px] font-medium text-muted-foreground sm:text-xs"
          >
            {s}
          </div>
        ))}
      </div>

      <Connector />

      {/* The chokepoint itself. */}
      <div className="lp-grad-surface rounded-xl p-px">
        <div className="rounded-[11px] bg-background px-4 py-3 text-center">
          <code className="font-mono text-sm font-semibold text-foreground">
            invoke()
          </code>
          <p className="mt-1 text-[11px] text-muted-foreground">
            the only way a capability reaches a handler
          </p>
        </div>
      </div>

      <Connector />

      {/* What the boundary does, in order. */}
      <ul className="space-y-2">
        {GATES.map((g, i) => (
          <li
            key={g.label}
            className="flex items-start gap-3 rounded-lg border border-border/70 bg-background/60 px-3 py-2.5"
          >
            <span className="mt-px font-mono text-[11px] text-[var(--_ember-flame,#FF7E5F)]">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="min-w-0">
              <span className="text-xs font-semibold text-foreground">
                {g.label}
              </span>{" "}
              <span className="text-xs text-muted-foreground">{g.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {/* The residue: what an auditor reads afterwards. */}
      <div className="mt-5 border-t border-border pt-4">
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Audit trail
        </p>
        <ul className="mt-2.5 space-y-1.5">
          {LEDGER.map((row) => (
            <li
              key={row.actor}
              className="flex items-center gap-2.5 font-mono text-[11px]"
            >
              <span
                className={
                  row.verdict === "denied"
                    ? "shrink-0 rounded border border-border px-1.5 py-0.5 text-muted-foreground"
                    : "shrink-0 rounded border border-[var(--_ember-flame,#FF7E5F)]/40 px-1.5 py-0.5 text-[var(--_ember-flame,#FF7E5F)]"
                }
              >
                {row.verdict}
              </span>
              <span className="shrink-0 text-foreground">{row.actor}</span>
              <span className="truncate text-muted-foreground">
                {row.action}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
