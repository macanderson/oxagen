/**
 * review-links.tsx — Overview → "Needs attention" quick links.
 *
 * A STATIC list of links to the surfaces that own reviewable work (memory
 * promotions, open sessions). It invokes no capability and therefore shows no
 * counts: it cannot tell you whether anything actually needs attention, only
 * where to go and look. Wiring real pending-item counts needs a capability that
 * returns them; until then, keep this honest — do not add a badge here that is
 * not backed by a live read.
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
