"use client";

import * as React from "react";
import { X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { PropertyItem } from "./types";

const DATA_TYPES: PropertyItem["dataType"][] = [
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "url",
  "email",
  "enum",
  "json",
  "array",
];

interface PropertyTableProps {
  properties: PropertyItem[];
  onAdd: (p: PropertyItem) => void;
  onUpdate: (index: number, p: PropertyItem) => void;
  onRemove: (index: number) => void;
  readOnly?: boolean;
}

export function PropertyTable({
  properties,
  onAdd,
  onUpdate,
  onRemove,
  readOnly = false,
}: PropertyTableProps) {
  const handleAddRow = () => {
    onAdd({ key: "", dataType: "string", required: false });
  };

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border overflow-hidden">
        {/* table-fixed so column widths are honored regardless of cell content
            (auto layout let Key/Type hog space and truncated Description/Example).
            Description + Example get the largest share since that's the data the
            user is typing and reading back. */}
        <table className="w-full table-fixed text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[16%]">
                Key
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[14%]">
                Type
              </th>
              <th className="px-3 py-2 text-center font-medium text-muted-foreground w-[9%]">
                Required
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[33%]">
                Description
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[22%]">
                Example
              </th>
              {!readOnly && (
                <th className="px-3 py-2 w-[6%]" aria-label="Actions" />
              )}
            </tr>
          </thead>
          <tbody
            className={cn(
              "divide-y divide-border",
              properties.length === 0 && "hidden",
            )}
          >
            {properties.map((prop, idx) => (
              <tr key={idx} className="bg-card">
                <td className="px-3 py-2">
                  <Input
                    value={prop.key}
                    onChange={(e) =>
                      onUpdate(idx, { ...prop, key: e.target.value })
                    }
                    placeholder="propertyName"
                    disabled={readOnly}
                    className="h-7 text-sm"
                  />
                </td>
                <td className="px-3 py-2">
                  <Select
                    value={prop.dataType}
                    onValueChange={(v) =>
                      onUpdate(idx, {
                        ...prop,
                        dataType: v as PropertyItem["dataType"],
                      })
                    }
                    disabled={readOnly}
                  >
                    <SelectTrigger className="h-7 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DATA_TYPES.map((dt) => (
                        <SelectItem key={dt} value={dt}>
                          {dt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-2 text-center">
                  <Checkbox
                    checked={prop.required}
                    onCheckedChange={(checked) =>
                      onUpdate(idx, { ...prop, required: Boolean(checked) })
                    }
                    disabled={readOnly}
                    aria-label="Required"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    value={prop.description ?? ""}
                    onChange={(e) =>
                      onUpdate(idx, { ...prop, description: e.target.value })
                    }
                    placeholder="Description"
                    disabled={readOnly}
                    className="h-7 text-sm"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    value={prop.example ?? ""}
                    onChange={(e) =>
                      onUpdate(idx, { ...prop, example: e.target.value })
                    }
                    placeholder="e.g. John"
                    disabled={readOnly}
                    className="h-7 text-sm"
                  />
                </td>
                {!readOnly && (
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => onRemove(idx)}
                      aria-label="Remove property"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {properties.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No properties defined.
          </div>
        )}
      </div>
      {!readOnly && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddRow}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add property
        </Button>
      )}
    </div>
  );
}
