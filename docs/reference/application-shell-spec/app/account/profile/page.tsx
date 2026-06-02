import { SimplePage } from "@/components/shell/simple-page"

export default function ProfilePage() {
  return (
    <SimplePage
      title="Profile"
      description="Your personal information, shown across every organization you belong to."
      crumbs={[
        { label: "Account", href: "/account/profile" },
        { label: "Profile", href: "/account/profile" },
      ]}
      sections={[
        { title: "Identity", description: "Name, avatar, and display preferences." },
        { title: "Contact", description: "Email addresses and phone numbers." },
        { title: "Localization", description: "Language, timezone, and date format." },
        { title: "Connected accounts", description: "Linked identity providers." },
      ]}
    />
  )
}
