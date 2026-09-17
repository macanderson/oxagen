// The pieces both Organization tabs draw from: an instant printed as a date,
// and the class recipe for the line a section prints in place of a table it
// has no rows for.
import { useFormatter } from "next-intl";

export const emptyLine = "text-sm text-muted-foreground";

export function DateCell({ iso }: { iso: string }) {
  const format = useFormatter();
  return (
    <time dateTime={iso}>
      {format.dateTime(new Date(iso), { dateStyle: "medium" })}
    </time>
  );
}
