"use client";
// Client-side navigation (ARCHITECTURE.md §3.8, INV-13): the only useRouter
// importer and the only file with a computed href or form action. Links take a
// SafePath, so a target that did not come from sanitizeNext or a route builder
// does not compile; the three external links take a HostedInvoiceUrl, a
// PullRequestUrl and a GitHubUrl.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentProps, useMemo } from "react";
import type { GitHubUrl } from "@/shared/github-url";
import type { HostedInvoiceUrl } from "@/shared/invoice-url";
import type { RunExportDownloadUrl } from "@/shared/run-export-download-url";
import type { PullRequestUrl } from "@/shared/pull-request-url";
import type { SafePath } from "@/shared/safe-path";

export function useNavigate(): {
  push(path: SafePath): void;
  /** Replaces the entry and re-renders the server components, for a navigation after the session or a membership changed. */
  replace(path: SafePath): void;
  /**
   * Re-renders the server components at the URL already showing, for a re-read
   * that is not a navigation. A poll uses this rather than `replace`, which
   * would push a history entry and fetch the same route twice.
   */
  refresh(): void;
} {
  const router = useRouter();
  // Memoised on the router: an effect that navigates has to list this object,
  // and a fresh literal every render makes that effect fire every render.
  return useMemo(
    () => ({
      push(path: SafePath) {
        router.push(path);
      },
      replace(path: SafePath) {
        router.replace(path);
        router.refresh();
      },
      refresh() {
        router.refresh();
      },
    }),
    [router],
  );
}

export function SafeLink({
  to,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { to: SafePath }) {
  return <Link href={to} {...props} />;
}

export function SafeForm({
  action,
  ...props
}: Omit<ComponentProps<"form">, "action"> & {
  action: SafePath | ((formData: FormData) => void | Promise<void>);
}) {
  return <form action={action} {...props} />;
}

/**
 * A file this app serves, fetched when the person asks for it.
 *
 * Deliberately not `SafeLink`: `next/link` prefetches on viewport entry in a
 * production build, which would open the private storage stream for the whole
 * archive before anyone clicked, and would then do the work again on the
 * click. It also treats a click as a client-side navigation, which is not what
 * a route handler streaming bytes wants. A plain anchor with `download` keeps
 * fetching an explicit act, and the path stays a `SafePath`.
 */
export function DownloadLink({
  to,
  ...props
}: Omit<ComponentProps<"a">, "href" | "download"> & { to: SafePath }) {
  return <a href={to} download {...props} />;
}

/**
 * A run export bundle on the API's signed download route, fetched when the
 * person asks for it. It is not a route of this app, so it takes its own brand
 * rather than a SafePath.
 */
export function RunExportDownloadLink({
  to,
  ...props
}: Omit<ComponentProps<"a">, "href" | "download"> & {
  to: RunExportDownloadUrl;
}) {
  return <a href={to} download {...props} />;
}

/** A Stripe-hosted invoice page, opened in a new tab without handing it this window. */
export function HostedInvoiceLink({
  to,
  ...props
}: Omit<ComponentProps<"a">, "href" | "target" | "rel"> & {
  to: HostedInvoiceUrl;
}) {
  return <a href={to} target="_blank" rel="noopener noreferrer" {...props} />;
}

/** A GitHub pull request page, opened in a new tab without handing it this window. */
export function PullRequestLink({
  to,
  ...props
}: Omit<ComponentProps<"a">, "href" | "target" | "rel"> & {
  to: PullRequestUrl;
}) {
  return <a href={to} target="_blank" rel="noopener noreferrer" {...props} />;
}

/** A page on github.com — a repository, the App's install page, its settings — opened without handing it this window. */
export function GitHubLink({
  to,
  ...props
}: Omit<ComponentProps<"a">, "href" | "target" | "rel"> & {
  to: GitHubUrl;
}) {
  return <a href={to} target="_blank" rel="noopener noreferrer" {...props} />;
}
