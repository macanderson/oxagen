"use client";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@oxagen/auth/client";

export function OAuthButtons({ callbackURL = "/" }: { callbackURL?: string }) {
  const handle = (provider: "google" | "github") => () =>
    authClient.signIn.social({ provider, callbackURL });

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" size="lg" onClick={handle("google")}>
        <GoogleIcon /> Continue with Google
      </Button>
      <Button type="button" variant="outline" size="lg" onClick={handle("github")}>
        <Github className="h-4 w-4" /> Continue with GitHub
      </Button>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4">
      <path
        fill="currentColor"
        d="M12 11v3.1h7c-.3 1.9-2.2 5.6-7 5.6-4.2 0-7.6-3.5-7.6-7.7S7.8 4.3 12 4.3c2.4 0 4 .9 5 1.8L19.5 4C17.9 2.5 15.3 1.5 12 1.5 6.2 1.5 1.5 6.2 1.5 12S6.2 22.5 12 22.5c6.9 0 11.5-4.9 11.5-11.8 0-.8-.1-1.4-.2-2H12Z"
      />
    </svg>
  );
}
