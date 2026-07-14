"use client";

/**
 * sandbox-env-panel.tsx — the "Environment" panel for one live durable sandbox.
 *
 * Two jobs, both truthful and fully wired:
 *  1. Show the runtimes actually baked into the sandbox's image (read-only — the
 *     base version is fixed at warm time by the chosen template).
 *  2. Let a person install packages onto the LIVE sandbox without hand-typing
 *     shell: pick a package manager (npm / pip / apt, scoped to what the image
 *     ships), add package tokens as chips, and Install. The panel composes a
 *     safe `npm install …` / `pip install …` / `apt-get install …` command and
 *     runs it through the SAME injected `runCommand` the terminal uses — so the
 *     install streams into the logs and the file tree refreshes automatically.
 *
 * `runCommand` is INJECTED (like SandboxTerminal's) so this stays pure UI and is
 * unit-testable with a mock. Package tokens are validated to a safe charset
 * (`isValidPackageToken`) before they can reach the composed command.
 */

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Boxes,
  Check,
  Loader2,
  Package,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import type { RunCommandFn } from "@/components/sandbox/sandbox-terminal";
import {
  isValidPackageToken,
  managersForImage,
  parsePackageTokens,
  runtimesForImage,
  type PackageManagerId,
} from "@/components/sandbox/sandbox-runtimes";

export interface SandboxEnvPanelProps {
  /** Base image kind (agent | node | python | shell) — drives the manager set. */
  image: string;
  /** Injected runner — the detail page binds it to `run_sandbox_command`. */
  runCommand: RunCommandFn;
  /** Disable installing (session stopped / no manage rights). */
  disabled?: boolean;
  className?: string;
}

type InstallState =
  | { phase: "idle" }
  | { phase: "installing"; command: string }
  | { phase: "done"; command: string; exitCode: number; output: string }
  | { phase: "error"; command: string; message: string };

/** Keep the inline result compact — the full stream lives in the Logs panel. */
function tail(text: string, lines = 6): string {
  const rows = text.replace(/\s+$/, "").split("\n");
  return rows.slice(-lines).join("\n");
}

export function SandboxEnvPanel({
  image,
  runCommand,
  disabled = false,
  className,
}: SandboxEnvPanelProps) {
  const runtimes = useMemo(() => runtimesForImage(image), [image]);
  const managers = useMemo(() => managersForImage(image), [image]);

  const [managerId, setManagerId] = useState<PackageManagerId>(
    () => managers[0]?.id ?? "apt",
  );
  const manager = managers.find((m) => m.id === managerId) ?? managers[0];

  const [packages, setPackages] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallState>({ phase: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  const installing = install.phase === "installing";

  const addTokens = (raw: string) => {
    const tokens = parsePackageTokens(raw);
    if (tokens.length === 0) return;
    const invalid = tokens.filter((t) => !isValidPackageToken(t));
    if (invalid.length > 0) {
      setTokenError(`Not a valid package name: ${invalid.join(", ")}`);
      return;
    }
    setTokenError(null);
    setPackages((prev) => {
      const next = new Set(prev);
      for (const t of tokens) next.add(t);
      return [...next];
    });
    setDraft("");
  };

  const removePackage = (pkg: string) =>
    setPackages((prev) => prev.filter((p) => p !== pkg));

  const onDraftKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      if (draft.trim().length > 0) {
        e.preventDefault();
        addTokens(draft);
      }
      return;
    }
    // Backspace on an empty draft pops the last chip — the expected chip-input feel.
    if (e.key === "Backspace" && draft.length === 0 && packages.length > 0) {
      e.preventDefault();
      setPackages((prev) => prev.slice(0, -1));
    }
  };

  const runInstall = async () => {
    if (!manager || disabled) return;
    // Fold any un-committed draft into the list first.
    const pending = parsePackageTokens(draft);
    const all = [...new Set([...packages, ...pending])];
    if (all.length === 0) {
      setTokenError("Add at least one package.");
      inputRef.current?.focus();
      return;
    }
    if (all.some((t) => !isValidPackageToken(t))) {
      setTokenError("Remove invalid package names before installing.");
      return;
    }
    setTokenError(null);
    setPackages(all);
    setDraft("");
    const command = manager.install(all);
    setInstall({ phase: "installing", command });
    try {
      const result = await runCommand(command);
      const output = tail(
        [result.stdout, result.stderr].filter(Boolean).join("\n"),
      );
      setInstall({
        phase: "done",
        command,
        exitCode: result.exitCode,
        output,
      });
      // A clean install clears the chips so the next batch starts fresh.
      if (result.exitCode === 0) setPackages([]);
    } catch (err) {
      setInstall({
        phase: "error",
        command,
        message: err instanceof Error ? err.message : "Install failed.",
      });
    }
  };

  return (
    <section
      data-testid="sandbox-env-panel"
      className={cn(
        "flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden />
          Environment
        </h2>
        <p className="text-xs text-muted-foreground">
          Runtimes baked into this sandbox, plus one-tap package installs into
          the live workspace.
        </p>
      </div>

      {/* Runtimes present (read-only, truthful). */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Runtimes
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {runtimes.map((r) => (
            <Badge
              key={`${r.name}-${r.version}`}
              variant="muted"
              size="sm"
              className="font-normal"
            >
              {r.name} {r.version}
            </Badge>
          ))}
          <span className="text-[11px] text-muted-foreground">
            fixed by the template chosen at warm time
          </span>
        </div>
      </div>

      {/* Package installer. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <Package className="h-3 w-3" aria-hidden />
            Install packages
          </span>
          {managers.length > 1 ? (
            <SegmentedControl
              value={managerId}
              onValueChange={(v) => setManagerId(v as PackageManagerId)}
              aria-label="Package manager"
              className="h-7"
            >
              {managers.map((m) => (
                <SegmentedControlItem
                  key={m.id}
                  value={m.id}
                  disabled={disabled || installing}
                  className="px-2.5 py-0.5 text-xs"
                >
                  {m.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          ) : null}
        </div>

        {/* Chip input: typed tokens become removable chips. */}
        <div
          className={cn(
            "flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring",
            disabled && "opacity-60",
          )}
          onClick={() => inputRef.current?.focus()}
        >
          {packages.map((pkg) => (
            <span
              key={pkg}
              data-testid="sandbox-pkg-chip"
              className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
            >
              {pkg}
              <button
                type="button"
                aria-label={`Remove ${pkg}`}
                className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(e) => {
                  e.stopPropagation();
                  removePackage(pkg);
                }}
                disabled={installing}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKeyDown}
            onBlur={() => draft.trim().length > 0 && addTokens(draft)}
            disabled={disabled || installing}
            placeholder={
              packages.length === 0
                ? (manager?.placeholder ?? "package name")
                : "add another…"
            }
            aria-label="Package name"
            data-testid="sandbox-pkg-input"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {manager?.hint}
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => void runInstall()}
            disabled={
              disabled ||
              installing ||
              (packages.length === 0 && draft.trim().length === 0)
            }
            data-testid="sandbox-pkg-install"
            className="shrink-0 gap-1"
          >
            {installing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden />
            )}
            {installing ? "Installing…" : "Install"}
          </Button>
        </div>

        {tokenError ? (
          <p role="alert" className="text-xs text-error">
            {tokenError}
          </p>
        ) : null}

        {/* Inline result — the full stream lives in the Logs panel. */}
        {install.phase === "done" ? (
          <div
            data-testid="sandbox-pkg-result"
            className={cn(
              "flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs",
              install.exitCode === 0
                ? "border-success/30 bg-success/10"
                : "border-error/30 bg-error/10",
            )}
          >
            <span
              className={cn(
                "flex items-center gap-1.5 font-medium",
                install.exitCode === 0 ? "text-success" : "text-error",
              )}
            >
              {install.exitCode === 0 ? (
                <Check className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
              )}
              {install.exitCode === 0
                ? "Installed"
                : `Install failed (exit ${install.exitCode})`}
            </span>
            {install.output ? (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                {install.output}
              </pre>
            ) : null}
          </div>
        ) : install.phase === "error" ? (
          <p role="alert" className="text-xs text-error">
            {install.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default SandboxEnvPanel;
