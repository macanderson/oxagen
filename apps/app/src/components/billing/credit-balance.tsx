"use client";
import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents, formatDate } from "@/lib/utils";

export interface CreditLedgerEntry {
  id: string;
  deltaCents: number;
  reason: string;
  createdAt: string;
}

export interface CreditBalanceProps {
  balanceCents: number;
  ledger: CreditLedgerEntry[];
}

export function CreditBalance({ balanceCents, ledger }: CreditBalanceProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Credit balance</span>
          <span className="text-2xl font-bold tabular-nums">{formatCents(balanceCents)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} className="-mx-2">
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Recent ledger entries
        </Button>
        {open ? (
          <ul className="mt-2 divide-y divide-border/60 text-sm">
            {ledger.length === 0 ? (
              <li className="py-2 text-muted-foreground">No ledger entries.</li>
            ) : (
              ledger.map((e) => (
                <li key={e.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="font-medium">{e.reason}</div>
                    <div className="text-xs text-muted-foreground">{formatDate(e.createdAt)}</div>
                  </div>
                  <Badge variant={e.deltaCents >= 0 ? "success" : "destructive"}>
                    {e.deltaCents >= 0 ? "+" : ""}
                    {formatCents(e.deltaCents)}
                  </Badge>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
