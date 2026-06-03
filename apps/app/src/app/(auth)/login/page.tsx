import Link from "next/link";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LoginForm } from "@/components/auth/login-form";
import { OAuthButtons } from "@/components/auth/oauth-buttons";

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>Sign in to your Oxagen workspace.</CardDescription>
        </CardHeader>
        <CardPanel>
          <OAuthButtons callbackURL="/" />
          <div className="relative my-6 flex items-center">
            <Separator className="flex-1" />
            <span className="px-3 text-xs uppercase text-muted-foreground">Or</span>
            <Separator className="flex-1" />
          </div>
          <LoginForm mode="signin" />
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Don&rsquo;t have an account?{" "}
            <Link href="/signup" className="text-accent hover:underline">
              Sign up
            </Link>
          </p>
        </CardPanel>
      </Card>
    </div>
  );
}
