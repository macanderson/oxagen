"use client";
// Client-side navigation (ARCHITECTURE.md §3.8, INV-13): the only useRouter
// importer and the only file with a computed href or form action. Links take a
// SafePath, so a target that did not come from sanitizeNext or a route builder
// does not compile.
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import type { SafePath } from "@/shared/safe-path";

export function useNavigate(): {
  push(path: SafePath): void;
  /** Replaces the entry and re-renders the server components, for a navigation after the session or a membership changed. */
  replace(path: SafePath): void;
} {
  const router = useRouter();
  return {
    push(path) {
      router.push(path);
    },
    replace(path) {
      router.replace(path);
      router.refresh();
    },
  };
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
