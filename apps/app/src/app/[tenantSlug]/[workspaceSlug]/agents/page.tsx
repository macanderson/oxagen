import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AgentsStubPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Agents</CardTitle>
          <CardDescription>The agent authoring surface ships in a later epic.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Agent records exist in the database and are reachable via the API. UI for authoring lands after the
            foundations milestone.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
