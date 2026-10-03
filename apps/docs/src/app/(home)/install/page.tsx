import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { OxagenIcon } from "@oxagen/ui";
import { CopyCommand } from "@/components/landing/copy-command";
import { InstallTerminal } from "@/components/landing/install-terminal";
import { HexField } from "@/components/ui/hex-field";
import { INSTALL_CMD } from "@/lib/install";

export const metadata: Metadata = {
  title: "Install the Oxagen CLI",
  description:
    "The oxagen CLI puts agent fleet management in your terminal. One command detects your platform, verifies the checksum, and installs the binary to ~/.local/bin. Add the skills pack with npx and query your workspace from the terminal.",
};

const SKILLS_CMD = "npx @oxagen/skills@latest install";

/* The three install steps, in the order the terminal animation plays them. */
const STEPS = [
  {
    step: "01",
    title: "Install the agent skills",
    body: "The skills pack carries the reusable skills, workflows, prompts, and tool definitions the CLI loads at startup. One npx command unpacks them to ~/.oxagen/skills.",
    command: SKILLS_CMD,
  },
  {
    step: "02",
    title: "Install the binary",
    body: "install.sh detects your platform, downloads the matching oxagen executable, checks its SHA-256, and installs it to ~/.local/bin. If that directory is not on your PATH, the script prints the line to add to your shell profile.",
    command: INSTALL_CMD,
  },
  {
    step: "03",
    title: "Verify and sign in",
    body: "Run oxagen --version to confirm the install. Then run oxagen login to sign in to your organization and workspace.",
    command: "oxagen --version",
  },
];

/* Where to go once the binary is on PATH. */
const NEXT_STEPS = [
  {
    title: "Quickstart",
    body: "Sign in, pick a workspace, and ask your first question in five minutes.",
    href: "/docs/cli/quickstart",
  },
  {
    title: "Account setup",
    body: "Create your organization and workspace, then an Oxagen API key for the CLI.",
    href: "/docs/cli/account-setup",
  },
  {
    title: "Commands",
    body: "Every command: the agent loop, knowledge graph queries, and configuration.",
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
              <span className="ox-eyebrow !tracking-[0.14em]">
                Oxagen CLI
              </span>
            </span>

            <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              Run your agents <span className="lp-grad-text">as a fleet</span>.
            </h1>

            <p className="mt-5 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              The{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                oxagen
              </code>{" "}
              CLI puts the fleet in your terminal: the same knowledge graph, the
              same scoped retrieval, and the same audited{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                invoke()
              </code>{" "}
              boundary as the app. One command installs it.
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
                className="inline-flex h-11 items-center rounded-lg border border-border bg-card/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:border-brand/60"
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
              Skills, binary, <span className="lp-grad-text">sign in</span>.
            </h2>
            <p className="mt-4 text-base text-muted-foreground">
              Two commands install it and one verifies it, in the order the
              terminal above types them.
            </p>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border lg:grid-cols-3">
            {STEPS.map((s) => (
              <div
                key={s.step}
                className="group relative flex flex-col bg-background p-7 sm:p-8"
              >
                <HexField className="pointer-events-none absolute inset-0 h-full w-full text-foreground opacity-0 transition-opacity duration-500 group-hover:opacity-30" />
                <span className="relative font-mono text-sm font-semibold text-[var(--ember-ink)]">
                  {s.step}
                </span>
                <h3 className="relative mt-3 text-lg font-semibold text-foreground">
                  {s.title}
                </h3>
                <p className="relative mt-3 flex-1 text-sm text-muted-foreground">
                  {s.body}
                </p>
                <code className="relative mt-5 block overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-muted/60 px-4 py-3 font-mono text-xs text-foreground">
                  <span className="select-none text-[var(--ember-ink)]">
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
            <span className="ox-eyebrow">install.sh</span>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              The install script
            </h2>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                install.sh
              </code>{" "}
              downloads one file and checks it before it installs anything.
              Read it before you run it.
            </p>
            <ul className="mt-7 space-y-3 text-sm">
              {[
                [
                  "Detects your platform",
                  "macOS on Apple silicon or Intel, or Linux on x86_64. The script downloads the matching executable from downloads.oxagen.sh.",
                ],
                [
                  "Verifies the checksum",
                  "The script checks the download against a published SHA-256 before it writes anything to disk.",
                ],
                [
                  "Installs to ~/.local/bin",
                  "If that directory is not on your PATH, the script prints the line to add to your shell profile.",
                ],
                [
                  "Never needs sudo",
                  "Everything lives in your home directory. To uninstall, delete one file.",
                ],
              ].map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />
                  <span>
                    <span className="font-medium text-foreground">{t}.</span>{" "}
                    <span className="text-muted-foreground">{d}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-border bg-card/70 p-6 backdrop-blur sm:p-8">
            <p className="ox-eyebrow">Other ways to install</p>
            <p className="mt-3 text-sm text-muted-foreground">
              On a CI runner or in a container, download the executable for
              your platform from downloads.oxagen.sh. It carries its own
              runtime, so it needs no Node.js.
            </p>
            <div className="mt-5 flex flex-col items-start gap-3">
              <CopyCommand command="curl -fsSLO https://downloads.oxagen.sh/latest/oxagen-x86_64-unknown-linux-gnu" />
            </div>
            <p className="mt-5 text-sm text-muted-foreground">
              The CLI is also on npm as{" "}
              <code className="font-mono">@oxagen/cli</code>, for Node.js 20 or
              newer. The{" "}
              <Link
                href="/docs/cli/installation"
                className="font-medium text-[var(--ember-ink)] hover:underline"
              >
                installation guide
              </Link>{" "}
              covers each way to install.
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
            <OxagenIcon className="size-12" />
            <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
              Give agents the business context{" "}
              <span className="lp-grad-text">their work requires</span>.
            </h2>
            <p className="mt-4 max-w-xl text-base text-muted-foreground">
              The CLI reads the same knowledge graph and the same record as the
              app and the API. Sign in and your workspace graph is on the other
              end of the prompt.
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {NEXT_STEPS.map((s) => (
              <Link key={s.href} href={s.href} className="group">
                <div className="flex h-full flex-col rounded-xl border border-border bg-background/60 p-6 backdrop-blur transition-colors hover:border-brand/60 hover:bg-muted/40">
                  <h3 className="text-base font-semibold text-foreground group-hover:text-[var(--ember-ink)]">
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
