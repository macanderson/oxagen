"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Mail, Bell, Smartphone, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { NotificationKind } from "@/lib/mock-data"

type Channel = "email" | "inApp" | "push"

const CHANNELS: { id: Channel; label: string; icon: typeof Mail; hint: string }[] = [
  { id: "email", label: "Email", icon: Mail, hint: "Sent to your verified address" },
  { id: "inApp", label: "In-app", icon: Bell, hint: "Shown in the notification center" },
  { id: "push", label: "Mobile push", icon: Smartphone, hint: "Pushed to paired devices" },
]

const EVENT_TYPES: { id: NotificationKind; label: string; description: string }[] = [
  {
    id: "approval",
    label: "Approvals",
    description: "Sign-offs requested before a playbook can run.",
  },
  { id: "run", label: "Runs", description: "Completion, failures, and retries." },
  { id: "member", label: "Members & access", description: "Invites, joins, and role changes." },
  { id: "security", label: "Security", description: "Token expiry and sign-in alerts." },
  { id: "system", label: "System", description: "Digests, quotas, and product updates." },
]

type Prefs = {
  channels: Record<Channel, boolean>
  matrix: Record<NotificationKind, Record<Channel, boolean>>
  digest: "realtime" | "hourly" | "daily" | "weekly"
  quietHours: boolean
  quietFrom: string
  quietTo: string
}

const DEFAULT_PREFS: Prefs = {
  channels: { email: true, inApp: true, push: false },
  matrix: {
    approval: { email: true, inApp: true, push: true },
    run: { email: false, inApp: true, push: false },
    member: { email: true, inApp: true, push: false },
    security: { email: true, inApp: true, push: true },
    system: { email: false, inApp: true, push: false },
  },
  digest: "daily",
  quietHours: true,
  quietFrom: "22:00",
  quietTo: "07:00",
}

const TIME_OPTIONS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`)

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [saved, setSaved] = useState<Prefs>(DEFAULT_PREFS)

  const dirty = JSON.stringify(prefs) !== JSON.stringify(saved)

  function toggleChannel(channel: Channel, value: boolean) {
    setPrefs((p) => ({ ...p, channels: { ...p.channels, [channel]: value } }))
  }

  function toggleMatrix(kind: NotificationKind, channel: Channel, value: boolean) {
    setPrefs((p) => ({
      ...p,
      matrix: { ...p.matrix, [kind]: { ...p.matrix[kind], [channel]: value } },
    }))
  }

  function save() {
    setSaved(prefs)
    toast.success("Notification preferences saved")
  }

  function reset() {
    setPrefs(saved)
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
      {/* Delivery channels */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery channels</CardTitle>
          <CardDescription>
            Turn entire channels on or off. Disabling a channel overrides the per-event settings
            below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {CHANNELS.map((c, i) => {
            const Icon = c.icon
            return (
              <div key={c.id}>
                {i > 0 && <Separator className="my-1" />}
                <div className="flex items-center justify-between gap-4 py-2">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <div>
                      <Label htmlFor={`channel-${c.id}`} className="text-sm font-medium">
                        {c.label}
                      </Label>
                      <p className="text-xs text-muted-foreground">{c.hint}</p>
                    </div>
                  </div>
                  <Switch
                    id={`channel-${c.id}`}
                    checked={prefs.channels[c.id]}
                    onCheckedChange={(v) => toggleChannel(c.id, v)}
                    aria-label={`Toggle ${c.label} channel`}
                  />
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* Per-event matrix */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Event types</CardTitle>
          <CardDescription>
            Fine-tune which channels each kind of notification uses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Column headers (hidden on mobile) */}
          <div className="mb-2 hidden grid-cols-[1fr_repeat(3,4rem)] items-center gap-2 px-1 sm:grid">
            <span className="text-xs font-medium text-muted-foreground">Notification</span>
            {CHANNELS.map((c) => (
              <span key={c.id} className="text-center text-xs font-medium text-muted-foreground">
                {c.label}
              </span>
            ))}
          </div>
          <div className="flex flex-col">
            {EVENT_TYPES.map((evt, i) => (
              <div key={evt.id}>
                {i > 0 && <Separator className="my-1" />}
                <div className="grid grid-cols-1 items-center gap-2 py-2 sm:grid-cols-[1fr_repeat(3,4rem)]">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{evt.label}</p>
                    <p className="text-xs text-muted-foreground">{evt.description}</p>
                  </div>
                  {CHANNELS.map((c) => {
                    const channelOff = !prefs.channels[c.id]
                    return (
                      <div
                        key={c.id}
                        className="flex items-center gap-2 sm:justify-center"
                      >
                        <span className="text-xs text-muted-foreground sm:hidden">{c.label}</span>
                        <Switch
                          checked={prefs.matrix[evt.id][c.id] && !channelOff}
                          disabled={channelOff}
                          onCheckedChange={(v) => toggleMatrix(evt.id, c.id, v)}
                          aria-label={`${evt.label} via ${c.label}`}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Email digest */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Email digest</CardTitle>
          <CardDescription>How often batched email summaries are delivered.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={prefs.digest}
            onValueChange={(v) => setPrefs((p) => ({ ...p, digest: v as Prefs["digest"] }))}
            className="grid gap-2 sm:grid-cols-2"
          >
            {(
              [
                { id: "realtime", label: "Real-time", hint: "Send each event as it happens" },
                { id: "hourly", label: "Hourly", hint: "Batched once an hour" },
                { id: "daily", label: "Daily", hint: "One summary each morning" },
                { id: "weekly", label: "Weekly", hint: "A single Monday digest" },
              ] as const
            ).map((opt) => (
              <Label
                key={opt.id}
                htmlFor={`digest-${opt.id}`}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted/50 has-[:checked]:border-brand has-[:checked]:bg-brand/5"
              >
                <RadioGroupItem id={`digest-${opt.id}`} value={opt.id} className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">{opt.label}</span>
                  <span className="block text-xs text-muted-foreground">{opt.hint}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      {/* Quiet hours */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quiet hours</CardTitle>
          <CardDescription>
            Pause push and email during a daily window. Security alerts always come through.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="quiet-toggle" className="text-sm font-medium">
              Enable quiet hours
            </Label>
            <Switch
              id="quiet-toggle"
              checked={prefs.quietHours}
              onCheckedChange={(v) => setPrefs((p) => ({ ...p, quietHours: v }))}
            />
          </div>
          {prefs.quietHours && (
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">From</Label>
                <Select
                  value={prefs.quietFrom}
                  onValueChange={(v) => setPrefs((p) => ({ ...p, quietFrom: v }))}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">To</Label>
                <Select
                  value={prefs.quietTo}
                  onValueChange={(v) => setPrefs((p) => ({ ...p, quietTo: v }))}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_OPTIONS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sticky save bar */}
      <div className="sticky bottom-4 z-10 flex items-center justify-end gap-2 rounded-lg border border-border bg-card/80 p-3 shadow-sm backdrop-blur">
        <p className="mr-auto text-sm text-muted-foreground">
          {dirty ? "You have unsaved changes." : "All changes saved."}
        </p>
        <Button variant="ghost" size="sm" onClick={reset} disabled={!dirty} className="gap-1.5">
          <RotateCcw className="size-4" aria-hidden="true" />
          Reset
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty}>
          Save changes
        </Button>
      </div>
    </div>
  )
}
