import { SimplePage } from "@/components/shell/simple-page"

export default function CasesPage() {
  return (
    <SimplePage
      title="Cases"
      description="Support cases you've opened and their current status."
      crumbs={[
        { label: "Account", href: "/account/profile" },
        { label: "Cases", href: "/account/cases" },
      ]}
      sections={[
        { title: "Open cases", description: "Cases awaiting a response." },
        { title: "Resolved", description: "Recently closed cases." },
        { title: "New case", description: "Start a new support request." },
        { title: "Knowledge base", description: "Self-serve help articles." },
      ]}
    />
  )
}
