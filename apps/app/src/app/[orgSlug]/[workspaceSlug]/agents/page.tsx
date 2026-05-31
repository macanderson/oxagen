import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AgentsStubPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Agents</CardTitle>
          <CardDescription>Agent authoring is coming soon.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Agents are available via the API today. A full authoring UI is on the way.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
