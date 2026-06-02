import { PageHeader, type Crumb } from "./page-header"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type Section = {
  title: string
  description: string
}

export function SimplePage({
  title,
  description,
  crumbs,
  sections,
}: {
  title: string
  description: string
  crumbs: Crumb[]
  sections: Section[]
}) {
  return (
    <div className="flex flex-col">
      <PageHeader title={title} description={description} crumbs={crumbs} />
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {sections.map((s) => (
            <Card key={s.title}>
              <CardHeader>
                <CardTitle className="text-base">{s.title}</CardTitle>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-24 rounded-md border border-dashed border-border bg-muted/40" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
