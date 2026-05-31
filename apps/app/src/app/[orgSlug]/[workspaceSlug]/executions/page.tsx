import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ExecutionsStubPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Executions</CardTitle>
          <CardDescription>Execution monitoring is coming soon.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You can query executions via the API today. A full monitoring dashboard is on the way.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
