"use client";
import { useRouter } from "next/navigation";

export function Go({ to }: { to: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        router.push(to);
      }}
    >
      go
    </button>
  );
}
