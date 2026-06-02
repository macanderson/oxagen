import { redirect } from "next/navigation";
import { account } from "@/lib/routes";

export default function AccountSecurityPage() {
  redirect(account.profile());
}
