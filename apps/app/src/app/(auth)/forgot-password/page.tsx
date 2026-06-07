import Link from "next/link";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Forgot your password?</CardTitle>
          <CardDescription>
            Enter your email and we&rsquo;ll send you a link to reset it.
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <ForgotPasswordForm />
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Remembered it?{" "}
            <Link href="/login" className="text-accent hover:underline">
              Sign in
            </Link>
          </p>
        </CardPanel>
      </Card>
    </div>
  );
}
