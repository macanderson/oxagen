import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ExecutionsStubPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Executions</CardTitle>
          <CardDescription>The execution monitoring UI ships in a later epic.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Execution tables exist; observability surfaces follow once the runner and telemetry pipeline land.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
