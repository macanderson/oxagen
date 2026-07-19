import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { OxagenLogomark } from "@oxagen/ui";
import { CopyCommand } from "@/components/landing/copy-command";
import { InstallTerminal } from "@/components/landing/install-terminal";
import { HexField } from "@/components/ui/hex-field";

export const metadata: Metadata = {
  title: "Install the Oxagen CLI",
  description:
    "One command puts the oxagen binary on your PATH: the install script detects your platform, verifies the checksum, and installs to ~/.local/bin. Add the agent skills pack with npx and start querying your workspace from the terminal.",
};

const INSTALL_CMD = "curl -fsSL https://cli.oxagen.sh/install.sh | sh";
const SKILLS_CMD = "npx @oxagen/skills@latest install";

/* The three install steps, in the order the terminal animation plays them. */
const STEPS = [
  {
    step: "01",
    title: "Install the agent skills",
    body: "The skills pack ships the agent's reusable capabilities — workflows, prompts, and tool definitions the CLI loads at startup. One npx command unpacks them to ~/.oxagen/skills.",
    command: SKILLS_CMD,
  },
  {
    step: "02",
    title: "Install the binary",
    body: "install.sh detects your platform, fetches the matching oxagen binary, verifies its checksum, and places it in ~/.local/bin — a directory already on your PATH, no shell-profile edits required.",
    command: INSTALL_CMD,
  },
  {
    step: "03",
    title: "Verify and go",
    body: "Run oxagen --version to confirm the install, then oxagen login to connect your organization and workspace. Your first question is one command away.",
    command: "oxagen --version",
  },
];

/* Where to go once the binary is on PATH. */
const NEXT_STEPS = [
  {
    title: "Quickstart",
    body: "Log in, pick a workspace, ask your first question — five minutes end to end.",
    href: "/docs/cli/quickstart",
  },
  {
    title: "Account setup",
    body: "Create your organization and workspace, mint an API key, connect the CLI.",
    href: "/docs/cli/account-setup",
  },
  {
    title: "Commands",
    body: "The full command reference — agent loop, knowledge graph queries, configuration.",
    href: "/docs/cli/commands",
  },
];

export default function InstallPage(): ReactNode {
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
              <OxagenLogomark className="size-3.5" />
              <span className="ox-eyebrow !text-[11px] !tracking-[0.14em]">
                Oxagen CLI
              </span>
            </span>

            <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              Your workspace, <span className="lp-grad-text">one command</span>{" "}
              away.
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              The{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                oxagen
              </code>{" "}
              CLI brings the governed agent to your terminal — the same
              knowledge graph, the same RBAC-scoped retrieval, the same audited{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                invoke()
              </code>{" "}
              chokepoint. Install it in seconds; no shell-profile surgery.
            </p>

            <div className="mt-8">
              <CopyCommand command={INSTALL_CMD} />
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/docs/cli/quickstart"
                className="lp-grad-surface inline-flex h-11 items-center rounded-lg px-6 text-sm font-semibold text-ink-dark shadow-sm transition-transform hover:scale-[1.02] active:scale-100"
              >
                CLI quickstart
              </Link>
              <Link
                href="/docs/cli"
                className="inline-flex h-11 items-center rounded-lg border border-border bg-card/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-flame,#F07650)]/60"
              >
                CLI docs
              </Link>
            </div>
          </div>

          {/* animated install terminal */}
          <div className="relative w-full">
            <InstallTerminal />
          </div>
        </div>
      </section>

      {/* ── Three steps ───────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border bg-muted/20">
        <HexField className="pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-40" />
        <div className="relative z-10 mx-auto w-full max-w-7xl px-6 py-20 lg:py-28">
          <div className="max-w-2xl">
            <span className="ox-eyebrow">Installation</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Skills, binary, <span className="lp-grad-text">go</span>.
            </h2>
            <p className="mt-4 text-base text-muted-foreground">
              Two commands to install, one to verify — exactly the sequence the
              terminal above is typing.
            </p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border lg:grid-cols-3">
            {STEPS.map((s) => (
              <div
                key={s.step}
                className="group relative flex flex-col bg-background p-7 sm:p-8"
              >
                <HexField className="pointer-events-none absolute inset-0 h-full w-full text-foreground opacity-0 transition-opacity duration-500 group-hover:opacity-30" />
                <span className="relative font-mono text-sm font-semibold text-[var(--_ember-flame,#F07650)]">
                  {s.step}
                </span>
                <h3 className="relative mt-3 text-lg font-semibold text-foreground">
                  {s.title}
                </h3>
                <p className="relative mt-3 flex-1 text-sm text-muted-foreground">
                  {s.body}
                </p>
                <code className="relative mt-5 block overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-muted/60 px-4 py-3 font-mono text-xs text-foreground">
                  <span className="select-none text-[var(--_ember-flame,#F07650)]">
                    ${" "}
                  </span>
                  {s.command}
                </code>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── What install.sh does ──────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-b border-border">
        <div className="relative mx-auto grid w-full max-w-7xl items-center gap-12 px-6 py-20 lg:grid-cols-[1fr_1.1fr] lg:py-28">
          <div>
            <span className="ox-eyebrow">Under the hood</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              A boring install script,{" "}
              <span className="lp-grad-text">on purpose</span>.
            </h2>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                install.sh
              </code>{" "}
              does four predictable things and nothing else — read it before you
              run it, we insist.
            </p>
            <ul className="mt-7 space-y-3 text-sm">
              {[
                [
                  "Detects your platform",
                  "macOS or Linux, arm64 or x64 — and fetches the matching prebuilt binary.",
                ],
                [
                  "Verifies the checksum",
                  "The download is checked against a published SHA-256 before anything touches disk.",
                ],
                [
                  "Installs to ~/.local/bin",
                  "The XDG-standard user binary directory, already on PATH in modern shells — no profile edits.",
                ],
                [
                  "Never needs sudo",
                  "Everything lives in your home directory; uninstalling is deleting one file.",
                ],
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

          <div className="rounded-2xl border border-border bg-card/70 p-6 backdrop-blur sm:p-8">
            <p className="ox-eyebrow">Prefer a package manager?</p>
            <p className="mt-3 text-sm text-muted-foreground">
              The CLI is also published to npm — install it globally with your
              package manager of choice and get the same binary on your PATH.
            </p>
            <div className="mt-5 flex flex-col items-start gap-3">
              <CopyCommand command="pnpm add -g @oxagen/cli" />
              <CopyCommand command="npm install -g @oxagen/cli" />
            </div>
            <p className="mt-5 text-sm text-muted-foreground">
              Full options — building from source, the portable single-file
              bundle for CI runners — are in the{" "}
              <Link
                href="/docs/cli/installation"
                className="font-medium text-[var(--_ember-flame,#F07650)] hover:underline"
              >
                installation guide
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      {/* ── Next steps ────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-t border-border bg-muted/20">
        <div
          aria-hidden="true"
          className="lp-orb pointer-events-none absolute bottom-[-40%] left-1/2 -z-10 h-[480px] w-[760px] -translate-x-1/2 opacity-60"
        />
        <HexField className="pointer-events-none absolute inset-0 -z-10 h-full w-full text-foreground opacity-40" />
        <div className="relative z-10 mx-auto w-full max-w-7xl px-6 py-20 lg:py-24">
          <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
            <OxagenLogomark className="size-12" />
            <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
              Installed? <span className="lp-grad-text">Ask something.</span>
            </h2>
            <p className="mt-4 max-w-xl text-base text-muted-foreground">
              The CLI speaks to the same governed platform as the app and the
              API — log in and your workspace knowledge graph is on the other
              end of the prompt.
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {NEXT_STEPS.map((s) => (
              <Link key={s.href} href={s.href} className="group">
                <div className="flex h-full flex-col rounded-xl border border-border bg-background/60 p-6 backdrop-blur transition-colors hover:border-[var(--_ember-flame,#F07650)]/60 hover:bg-muted/40">
                  <h3 className="text-base font-semibold text-foreground group-hover:text-[var(--_ember-flame,#F07650)]">
                    {s.title}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
