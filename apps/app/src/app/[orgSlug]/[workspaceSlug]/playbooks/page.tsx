import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function PlaybooksStubPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Playbooks</CardTitle>
          <CardDescription>The playbook authoring surface ships in a later epic.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Playbook tables and versions are migrated. The UI is intentionally stubbed for the foundations milestone.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
