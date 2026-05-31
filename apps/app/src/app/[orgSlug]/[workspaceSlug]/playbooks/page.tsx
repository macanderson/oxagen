import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function PlaybooksStubPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Playbooks</CardTitle>
          <CardDescription>Playbook authoring is coming soon.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Playbooks are supported in the API today. A visual authoring experience is on the way.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
