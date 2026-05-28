import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

export interface Member {
  publicId: string;
  displayName: string | null;
  email: string;
  role: string;
  joinedAt: string | Date | null;
}

export function MemberList({ title, members }: { title: string; members: Member[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {members.map((m) => (
              <li key={m.publicId} className="flex items-center justify-between py-3">
                <div className="flex flex-col">
                  <span className="font-medium">{m.displayName ?? m.email}</span>
                  <span className="text-xs text-muted-foreground">{m.email}</span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline">{m.role}</Badge>
                  <span className="text-xs text-muted-foreground">Joined {formatDate(m.joinedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
