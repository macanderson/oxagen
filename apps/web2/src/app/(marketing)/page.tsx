import type { Metadata } from "next";
import { StaticMarketingPage } from "@/components/marketing/static-page";

export const metadata: Metadata = {
  title:
    "Oxagen — AI coding agents with your context. Governed, metered, on the record.",
  description:
    "Oxagen is an AI coding agent for your terminal and a control plane for your whole fleet. It turns your code and business data into one connected map, so agents get the right answer the first time — and every action is approved, measured, and on the record.",
  openGraph: {
    title: "Oxagen — Everyone has the same models. Your edge is context.",
    description:
      "An AI coding agent for your terminal, and a control plane for your whole fleet. Grounded in your own map of code and business data. Governed, metered, on the record.",
    images: ["/og.png"],
    type: "website",
  },
};

export default function HomePage() {
  return <StaticMarketingPage name="home" />;
}
