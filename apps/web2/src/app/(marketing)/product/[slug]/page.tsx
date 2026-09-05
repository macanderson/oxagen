import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StaticMarketingPage } from "@/components/marketing/static-page";

/**
 * The three products the home page's nav and hero already point at:
 * Stella (the open-source agent), Oxagen (the control plane), and Private
 * LLMs (self-hosted models). Content for each is migrated from
 * `apps/web/products/<slug>/index.html` — see
 * `src/content/marketing/README.md`.
 */
const PRODUCTS = {
  stella: {
    contentName: "stella",
    title: "Stella — the open-source coding agent that shows its work | Oxagen",
    description:
      "Stella is Oxagen's open-source terminal coding agent, written in Rust. Bring your own model keys, run any provider, and watch every turn, tool call, gate and cost on one deck.",
    ogTitle: "Stella — the open-source coding agent that shows its work",
    ogDescription:
      "A fast, BYOK, model-agnostic terminal coding agent in Rust. Every turn, tool call, gate and dollar on one deck.",
  },
  oxagen: {
    contentName: "oxagen",
    title: "Oxagen — the control plane for every agent you run",
    description:
      "One shared context map, rules that are approved before an action runs, metering across every agent and model, and a tamper-evident record after. The control plane behind your fleet.",
    ogTitle: "Oxagen — the control plane for every agent you run",
    ogDescription:
      "Approved before it runs. Measured as it runs. On the record after. One shared map behind all of it.",
  },
  "private-llms": {
    contentName: "private-llms",
    title: "Private LLMs — your model, your metal | Oxagen",
    description:
      "Run the agent on models you host: on the laptop, inside your VPC, or on a box with no route to the internet. Same agent, same deck, nothing leaving the building.",
    ogTitle: "Private LLMs — your model, your metal",
    ogDescription:
      "On the laptop, in your VPC, or air-gapped. Same agent, same deck, nothing leaving the building.",
  },
} as const;

type ProductSlug = keyof typeof PRODUCTS;

function isProductSlug(slug: string): slug is ProductSlug {
  return slug in PRODUCTS;
}

export function generateStaticParams() {
  return Object.keys(PRODUCTS).map((slug) => ({ slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  if (!isProductSlug(slug)) return {};
  const product = PRODUCTS[slug];
  return {
    title: product.title,
    description: product.description,
    openGraph: {
      title: product.ogTitle,
      description: product.ogDescription,
      images: ["/og.png"],
      type: "website",
    },
  };
}

export default async function ProductPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  if (!isProductSlug(slug)) notFound();
  return <StaticMarketingPage name={PRODUCTS[slug].contentName} />;
}
