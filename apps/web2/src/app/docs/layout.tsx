import "@/app/global.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export const metadata: Metadata = {
  title: {
    template: "%s | Oxagen Docs",
    default: "Oxagen Docs",
  },
  description:
    "Documentation for the Oxagen platform and Stella, the open-source terminal agent — one merged tree.",
};

// Docs-only CSS and Fumadocs' theme provider are scoped to this subtree via
// Next's per-layout CSS bundling, so the marketing routes under
// src/app/(marketing) never pay for (or fight with) the Fumadocs theme.
export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      <DocsLayout tree={source.pageTree} {...baseOptions()}>
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
