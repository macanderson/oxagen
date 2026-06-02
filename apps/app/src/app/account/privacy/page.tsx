import { redirect } from "next/navigation";
import { account } from "@/lib/routes";

export default function AccountPrivacyPage() {
  redirect(account.profile());
}
