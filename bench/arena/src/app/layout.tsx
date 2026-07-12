import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Oxagen Arena — Agentic Coding Benchmark Framework",
  description:
    "Scientifically rigorous comparison of agentic coding tools with full provenance tracking.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
