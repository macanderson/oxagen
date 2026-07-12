/**
 * Arena Configure Page
 *
 * Full configuration interface for benchmark runs with advanced options.
 */

import { DashboardShell } from "@/components/dashboard-shell";
import { ConfigureForm } from "@/components/configure-form";

export default function ConfigurePage() {
  return (
    <DashboardShell>
      <div className="space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Configure Benchmark</h1>
          <p className="text-muted-foreground">
            Fine-tune your benchmark run with advanced configuration options.
          </p>
        </div>

        <ConfigureForm />
      </div>
    </DashboardShell>
  );
}
