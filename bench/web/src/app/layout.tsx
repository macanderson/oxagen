import type { Metadata, Viewport } from "next";
import "./global.css";

export const metadata: Metadata = {
  title: "Oxagen SWE-bench Benchmarks",
  description:
    "Reproducible SWE-bench evaluations for AI coding agents. Every number is measured (with a reproduce command) or cited from a primary source — no simulated scores.",
};

export const viewport: Viewport = {
  themeColor: "#0b0d10",
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
