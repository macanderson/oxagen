/**
 * sandbox-template-card.tsx — the rich "what's in this sandbox" card shown when
 * a user picks a template to warm.
 *
 * It renders the truthful `contents` manifest from `warm-up-templates.ts` (which
 * mirrors the real Modal image build) so a person knows exactly what their agent
 * can run before they warm it: base OS, language runtimes + versions, package
 * managers, and pre-installed system packages. The blank preset instead shows a
 * "set it up, then snapshot it into a template" explainer.
 *
 * Presentational only — no hooks, no client state — so it renders in either a
 * server or client tree. Icons are Lucide, monochromatic by design (foreground /
 * muted tones, never a brand colour), matching the file-tree treatment.
 */
import {
  Bot,
  Hexagon,
  Braces,
  SquareTerminal,
  Boxes,
  Package,
  TerminalSquare,
  Sparkles,
  Layers,
  Camera,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WarmUpTemplate } from "@/components/sandbox/warm-up-templates";

// Data carries a Lucide icon *name*; map the small known set to components so
// the module stays a pure string source. Unknown names fall back to Boxes.
const ICONS: Record<string, LucideIcon> = {
  Bot,
  Hexagon,
  Braces,
  SquareTerminal,
};

/** A labelled row of monochromatic chips; renders nothing when empty. */
function ChipRow({
  icon: Icon,
  label,
  items,
}: {
  icon: LucideIcon;
  label: string;
  items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item}>
            <Badge variant="muted" size="sm" className="font-mono font-normal">
              {item}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface SandboxTemplateCardProps {
  template: WarmUpTemplate;
}

/**
 * The rich preview for a single warm-up template. Named surfaces:
 *  - header: monochromatic icon + label + base-OS badge
 *  - contents: languages, package managers, system packages, highlights
 *  - footer: the one-time warm-up command, or (for blank) the snapshot guide.
 */
export function SandboxTemplateCard({ template }: SandboxTemplateCardProps) {
  const Icon = ICONS[template.icon] ?? Boxes;
  const { contents } = template;
  const languages = contents.languages.map((l) => `${l.name} ${l.version}`);

  return (
    <section
      aria-label={`${template.label} details`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-muted/30 p-4"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{template.label}</h3>
            <Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
              {contents.base}
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {template.description}
          </p>
        </div>
      </div>

      {/* Contents grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChipRow icon={Layers} label="Languages" items={languages} />
        <ChipRow icon={Package} label="Package managers" items={contents.packageManagers} />
        <ChipRow icon={Boxes} label="System packages" items={contents.systemPackages} />
        {contents.highlights && contents.highlights.length > 0 ? (
          <ChipRow icon={Sparkles} label="Also baked in" items={contents.highlights} />
        ) : null}
      </div>

      {/* Footer: warm-up command, or the blank-sandbox snapshot guide */}
      {template.isBlank ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-background/60 p-3">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Camera className="size-3.5" aria-hidden />
            Make it your own template
          </span>
          <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            <li>Warm this bare sandbox and open its terminal.</li>
            <li>
              Install whatever your agent needs — e.g.{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                apt-get install …
              </code>
              , <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">npm i -g …</code>, clone a repo.
            </li>
            <li>
              Snapshot &amp; register it as a reusable template under{" "}
              <span className="font-medium text-foreground">Settings → Environments</span> so
              your team can warm the same setup in one click.
            </li>
          </ol>
        </div>
      ) : contents.packageManagers.length > 0 && template.setupCmd ? (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <TerminalSquare className="size-3.5" aria-hidden />
            Runs once at create time
          </span>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-muted-foreground">
            {template.setupCmd}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

export default SandboxTemplateCard;
