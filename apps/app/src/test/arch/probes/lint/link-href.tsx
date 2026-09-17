import Link from "next/link";

export function Go({ to }: { to: string }) {
  return <Link href={to}>go</Link>;
}
