import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function VerifyPage(_props: { searchParams: Promise<{ email?: string }> }) {
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>We sent you a verification link. Open it to finish signing in.</CardDescription>
        </CardHeader>
        <CardPanel>
          <p className="text-sm text-muted-foreground">
            Once you&rsquo;ve verified, you&rsquo;ll be redirected to your workspace.
          </p>
        </CardPanel>
      </Card>
    </div>
  );
}
