import { redirect } from "next/navigation";
import { account } from "@/lib/routes";

// /account has no index surface of its own — the account section is a set of
// sub-pages (profile, security, cases, notifications, privacy). Land visitors
// on Profile, the first item in the account sidebar.
export default function AccountHome() {
  redirect(account.profile());
}
