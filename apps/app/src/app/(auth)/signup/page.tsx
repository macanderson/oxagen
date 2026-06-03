import Link from "next/link";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LoginForm } from "@/components/auth/login-form";
import { OAuthButtons } from "@/components/auth/oauth-buttons";

export default function SignupPage() {
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>Start building agents on Oxagen.</CardDescription>
        </CardHeader>
        <CardPanel>
          <OAuthButtons callbackURL="/" />
          <div className="relative my-6 flex items-center">
            <Separator className="flex-1" />
            <span className="px-3 text-xs uppercase text-muted-foreground">Or</span>
            <Separator className="flex-1" />
          </div>
          <LoginForm mode="signup" />
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Already have one?{" "}
            <Link href="/login" className="text-accent hover:underline">
              Sign in
            </Link>
          </p>
        </CardPanel>
      </Card>
    </div>
  );
}
