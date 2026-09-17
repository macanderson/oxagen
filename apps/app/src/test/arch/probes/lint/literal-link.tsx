import Link from "next/link";

export function Go() {
  return (
    <>
      <Link href="/login">log in</Link>
      <a href="#main">skip</a>
    </>
  );
}
