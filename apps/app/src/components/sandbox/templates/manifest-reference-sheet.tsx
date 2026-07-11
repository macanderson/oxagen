"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetTrigger,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { MANIFEST_REFERENCE } from "./manifest-reference";

/**
 * The "how do I know all the configs I can make" affordance: every manifest
 * field, generated from the single `manifest-reference.ts` data module so
 * there is exactly one place to update as the schema grows.
 */
export function ManifestReferenceSheet() {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            className="max-md:h-11"
            data-testid="manifest-reference-open"
          />
        }
      >
        Manifest reference
      </SheetTrigger>
      <SheetPopup
        side="right"
        className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle>Sandbox-template manifest reference</SheetTitle>
          <SheetDescription>
            Every field the portable manifest v1 document carries — what it
            controls, its allowed values, and provider notes. Generated from the
            same schema the editor and import/export validate against.
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="gap-4">
          {MANIFEST_REFERENCE.map((section) => (
            <div
              key={section.key}
              className="flex flex-col gap-2 border-b border-border/30 pb-4 last:border-0"
            >
              <h4 className="text-sm font-semibold">{section.label}</h4>
              <p className="text-xs text-muted-foreground">{section.summary}</p>
              <dl className="flex flex-col gap-2">
                {section.fields.map((field) => (
                  <div
                    key={field.path}
                    className="rounded-md bg-muted/30 p-2 text-xs"
                  >
                    <dt className="font-mono font-medium">{field.path}</dt>
                    <dd className="mt-1 text-muted-foreground">
                      {field.type} · {field.values}
                    </dd>
                    <dd className="mt-1">{field.description}</dd>
                    {field.providerNotes && (
                      <dd className="mt-1 italic text-muted-foreground">
                        {field.providerNotes}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
