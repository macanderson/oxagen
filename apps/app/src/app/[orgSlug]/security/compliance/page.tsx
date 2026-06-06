import {
  ClipboardCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileDown,
  ChevronRight,
} from "lucide-react";
import {
  Card,
  CardPanel,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

// ---------------------------------------------------------------------------
// Mock data — pure presentational, zero live DB dependency (OXA-1579)
// ---------------------------------------------------------------------------

type ControlStatus = "active" | "partial" | "not_started";
type Framework = "SOC 2 Type II" | "HIPAA" | "GDPR";

interface ComplianceControl {
  id: string;
  criterion: string;
  title: string;
  description: string;
  status: ControlStatus;
  category: string;
  evidenceCount: number;
  lastReviewedAt: string | null;
}

interface FrameworkSummary {
  name: Framework;
  total: number;
  active: number;
  partial: number;
  notStarted: number;
}

const MOCK_CONTROLS: ComplianceControl[] = [
  {
    id: "cc6.1",
    criterion: "CC6.1",
    title: "Logical access controls",
    description:
      "The entity implements logical access security software, infrastructure, and architectures to protect against security events.",
    status: "active",
    category: "Logical & Physical Access",
    evidenceCount: 8,
    lastReviewedAt: "Jun 1, 2026",
  },
  {
    id: "cc6.2",
    criterion: "CC6.2",
    title: "Authentication and credential management",
    description:
      "Prior to issuing system credentials and granting system access, the entity registers and authorizes new internal and external users.",
    status: "active",
    category: "Logical & Physical Access",
    evidenceCount: 5,
    lastReviewedAt: "Jun 1, 2026",
  },
  {
    id: "cc6.3",
    criterion: "CC6.3",
    title: "Role-based access and least privilege",
    description:
      "The entity authorizes, modifies, or removes access to data, software, functions, and other protected information assets based on approved changes.",
    status: "active",
    category: "Logical & Physical Access",
    evidenceCount: 6,
    lastReviewedAt: "May 28, 2026",
  },
  {
    id: "cc6.7",
    criterion: "CC6.7",
    title: "Data transmission controls",
    description:
      "The entity restricts the transmission, movement, and removal of information to authorized internal and external users and processes.",
    status: "partial",
    category: "Logical & Physical Access",
    evidenceCount: 2,
    lastReviewedAt: "May 15, 2026",
  },
  {
    id: "cc7.1",
    criterion: "CC7.1",
    title: "System component configuration",
    description:
      "To meet its objectives, the entity uses detection and monitoring procedures to identify changes to configurations.",
    status: "active",
    category: "System Operations",
    evidenceCount: 4,
    lastReviewedAt: "Jun 2, 2026",
  },
  {
    id: "cc7.2",
    criterion: "CC7.2",
    title: "Security event monitoring",
    description:
      "The entity monitors system components and the operation of those components for anomalies that are indicative of malicious acts.",
    status: "active",
    category: "System Operations",
    evidenceCount: 7,
    lastReviewedAt: "Jun 6, 2026",
  },
  {
    id: "cc7.3",
    criterion: "CC7.3",
    title: "Incident identification and response",
    description:
      "The entity evaluates security events to determine whether they could or have resulted in a failure of the entity to meet its objectives.",
    status: "partial",
    category: "System Operations",
    evidenceCount: 1,
    lastReviewedAt: "May 10, 2026",
  },
  {
    id: "cc9.1",
    criterion: "CC9.1",
    title: "Business continuity planning",
    description:
      "The entity identifies, selects, and develops risk mitigation activities for risks arising from potential business disruptions.",
    status: "not_started",
    category: "Risk Mitigation",
    evidenceCount: 0,
    lastReviewedAt: null,
  },
  {
    id: "cc9.2",
    criterion: "CC9.2",
    title: "Vendor and third-party risk management",
    description:
      "The entity assesses and manages risks associated with vendors and business partners.",
    status: "partial",
    category: "Risk Mitigation",
    evidenceCount: 3,
    lastReviewedAt: "Apr 22, 2026",
  },
];

const FRAMEWORK_SUMMARIES: FrameworkSummary[] = [
  { name: "SOC 2 Type II", total: 9, active: 5, partial: 3, notStarted: 1 },
  { name: "HIPAA", total: 12, active: 4, partial: 5, notStarted: 3 },
  { name: "GDPR", total: 8, active: 3, partial: 3, notStarted: 2 },
];

const STATUS_VARIANT: Record<ControlStatus, "success" | "warning" | "error"> = {
  active: "success",
  partial: "warning",
  not_started: "error",
};

const STATUS_LABEL: Record<ControlStatus, string> = {
  active: "Active",
  partial: "Partial",
  not_started: "Not started",
};

const STATUS_ICON_COLOR: Record<ControlStatus, string> = {
  active: "text-[hsl(142_71%_45%)]",
  partial: "text-[hsl(38_92%_50%)]",
  not_started: "text-destructive",
};

function ControlStatusIcon({ status }: { status: ControlStatus }) {
  const cls = `mt-0.5 h-4 w-4 shrink-0 ${STATUS_ICON_COLOR[status]}`;
  if (status === "active") return <CheckCircle2 className={cls} aria-hidden="true" />;
  if (status === "partial") return <AlertTriangle className={cls} aria-hidden="true" />;
  return <XCircle className={cls} aria-hidden="true" />;
}

const categories = Array.from(new Set(MOCK_CONTROLS.map((c) => c.category)));

export default function SecurityCompliancePage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill — per scope requirement */}
      <div>
        <Badge variant="muted" className="text-[10px] tracking-wide uppercase">
          Preview · not yet wired to live data
        </Badge>
      </div>

      {/* Framework summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {FRAMEWORK_SUMMARIES.map((fw) => {
          const pct = Math.round((fw.active / fw.total) * 100);
          return (
            <Card key={fw.name}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-sm leading-snug">{fw.name}</CardTitle>
                  <Badge
                    variant={pct >= 80 ? "success" : pct >= 50 ? "warning" : "error"}
                    className="shrink-0 text-xs"
                  >
                    {pct}%
                  </Badge>
                </div>
              </CardHeader>
              <CardPanel>
                <div className="mb-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{fw.active} active</span>
                  <span>{fw.partial} partial</span>
                  <span>{fw.notStarted} not started</span>
                </div>
              </CardPanel>
            </Card>
          );
        })}
      </div>

      {/* Control catalog */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
                <ClipboardCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <div>
                <CardTitle>SOC 2 control catalog</CardTitle>
                <CardDescription>
                  Trust Service Criteria control status and evidence summary for SOC 2 Type II
                  audit readiness.
                </CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm">
              <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
              Export report
            </Button>
          </div>
        </CardHeader>
        <CardPanel>
          {categories.map((category, catIdx) => {
            const controls = MOCK_CONTROLS.filter((c) => c.category === category);
            return (
              <div key={category}>
                {catIdx > 0 && <Separator className="my-5" />}
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
                  {category}
                </p>
                <div className="flex flex-col gap-2">
                  {controls.map((ctrl) => (
                    <div
                      key={ctrl.id}
                      className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
                    >
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <ControlStatusIcon status={ctrl.status} />
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-foreground">
                              {ctrl.criterion}
                            </span>
                            <span className="text-sm font-medium text-foreground">
                              {ctrl.title}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground leading-snug">
                            {ctrl.description}
                          </p>
                          {ctrl.lastReviewedAt && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Last reviewed: {ctrl.lastReviewedAt}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                        <Badge variant={STATUS_VARIANT[ctrl.status]} className="text-xs">
                          {STATUS_LABEL[ctrl.status]}
                        </Badge>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {ctrl.evidenceCount} evidence item
                          {ctrl.evidenceCount !== 1 ? "s" : ""}
                        </span>
                        <button
                          type="button"
                          className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                        >
                          View
                          <ChevronRight className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </CardPanel>
      </Card>
    </div>
  );
}
