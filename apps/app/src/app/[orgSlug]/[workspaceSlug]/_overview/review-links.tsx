/**
 * review-links.tsx — Overview → "Needs attention" quick links.
 *
 * The spec sanctions only the four invoked tile capabilities (spend, runs,
 * graph, sources) — reviewable-item counts for memory promotions and plan
 * approvals are out of scope for this page. This row is
 * therefore a static list of links to the surfaces that own those reviews,
 * not a live capability invocation.
 */
import Link from "next/link";
import { BrainCircuit, Sparkles } from "lucide-react";
import { workspace } from "@/lib/routes";
import { Tile } from "../_shared/components";

interface ReviewLinksProps {
  orgSlug: string;
  workspaceSlug: string;
}

export function ReviewLinks({ orgSlug, workspaceSlug }: ReviewLinksProps) {
  const ctx = { orgSlug, workspaceSlug };
  const links = [
    {
      key: "memories",
      label: "Review memories",
      icon: BrainCircuit,
      href: workspace.knowledge.memory(ctx),
    },
    {
      key: "sessions",
      label: "Open Sessions",
      icon: Sparkles,
      href: workspace.sessions(ctx),
    },
  ] as const;

  return (
    <div data-testid="overview-review-links">
      <Tile title="Needs attention">
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {links.map(({ key, label, icon: Icon, href }) => (
            <li key={key}>
              <Link
                href={href}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </Tile>
    </div>
  );
}
