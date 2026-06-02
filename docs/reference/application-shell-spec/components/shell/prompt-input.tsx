"use client"

import { useEffect, useRef, useState } from "react"
import {
  Brain,
  ImageIcon,
  Paperclip,
  SlashSquare,
  Send,
  Sparkles,
  Video,
  X,
  FileText,
  Search,
  Code2,
  Languages,
  ListChecks,
  Bug,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  getModel,
  supportsEffort,
  supportsImage,
  supportsVideo,
  type EffortLevel,
} from "@/lib/models"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ModelPicker, defaultSelection, type ModelSelection } from "./model-picker"

export type MediaIntent = "image" | "video"

export type PromptSubmit = {
  text: string
  model: ModelSelection
  effort?: EffortLevel
  intent?: MediaIntent
  commands: string[]
}

type SlashCommand = {
  id: string
  label: string
  hint: string
  icon: typeof FileText
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: "summarize", label: "/summarize", hint: "Condense the current context", icon: FileText },
  { id: "search", label: "/search", hint: "Search across this workspace", icon: Search },
  { id: "code", label: "/code", hint: "Generate or refactor code", icon: Code2 },
  { id: "translate", label: "/translate", hint: "Translate to another language", icon: Languages },
  { id: "plan", label: "/plan", hint: "Draft a step-by-step plan", icon: ListChecks },
  { id: "debug", label: "/debug", hint: "Investigate an error or failure", icon: Bug },
]

export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = "Ask anything…",
  compact = false,
  autoFocus = false,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (payload: PromptSubmit) => void
  placeholder?: string
  compact?: boolean
  autoFocus?: boolean
}) {
  const [model, setModel] = useState<ModelSelection>(defaultSelection)
  const [effort, setEffort] = useState<EffortLevel>("medium")
  const [intent, setIntent] = useState<MediaIntent | null>(null)
  const [commands, setCommands] = useState<string[]>([])
  const [improving, setImproving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resolved = getModel(model.modelId)
  const canEffort = supportsEffort(resolved)
  const canImage = supportsImage(resolved)
  const canVideo = supportsVideo(resolved)

  // Drop any media intent the newly-selected model can't honor.
  useEffect(() => {
    if (intent === "image" && !canImage) setIntent(null)
    if (intent === "video" && !canVideo) setIntent(null)
  }, [intent, canImage, canVideo])

  function submit() {
    const text = value.trim()
    if (!text && commands.length === 0) return
    onSubmit({
      text,
      model,
      effort: canEffort ? effort : undefined,
      intent: intent ?? undefined,
      commands,
    })
    onChange("")
    setIntent(null)
    setCommands([])
  }

  function toggleIntent(next: MediaIntent) {
    setIntent((cur) => (cur === next ? null : next))
  }

  function addCommand(label: string) {
    setCommands((cur) => (cur.includes(label) ? cur : [...cur, label]))
    textareaRef.current?.focus()
  }

  function removeCommand(label: string) {
    setCommands((cur) => cur.filter((c) => c !== label))
  }

  function improvePrompt() {
    const text = value.trim()
    if (!text || improving) return
    setImproving(true)
    // Fake "improve" pass — in a real build this would call the model.
    setTimeout(() => {
      onChange(
        `${text}\n\nBe specific and thorough. Include concrete examples, edge cases, and a short summary of the approach at the end.`,
      )
      setImproving(false)
      textareaRef.current?.focus()
    }, 650)
  }

  const hasChips = Boolean(intent) || commands.length > 0

  return (
    <div
      className={cn(
        "glass-strong gradient-ring flex flex-col rounded-2xl border border-border/50 shadow-lg transition-all duration-200 focus-within:shadow-xl focus-within:ring-2 focus-within:ring-brand/30",
        compact && "rounded-xl",
      )}
    >
      {/* Chips: media intent + slash command pills */}
      {hasChips && (
        <div className="flex flex-wrap gap-2 px-4 pt-4">
          {intent && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand">
              {intent === "image" ? (
                <ImageIcon className="size-3.5" />
              ) : (
                <Video className="size-3.5" />
              )}
              {intent === "image" ? "Generate image" : "Generate video"}
              <button
                onClick={() => setIntent(null)}
                aria-label={`Remove ${intent} intent`}
                className="ml-0.5 rounded-full p-0.5 hover:bg-brand/20"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {commands.map((cmd) => (
            <span
              key={cmd}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 font-mono text-xs font-medium text-foreground"
            >
              {cmd}
              <button
                onClick={() => removeCommand(cmd)}
                aria-label={`Remove ${cmd} command`}
                className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        rows={compact ? 2 : 4}
        placeholder={
          intent === "image"
            ? "Describe the image you want…"
            : intent === "video"
              ? "Describe the video you want…"
              : placeholder
        }
        aria-label="Prompt"
        className={cn(
          "w-full resize-none bg-transparent px-4 pt-4 text-base leading-relaxed focus:outline-none",
          compact ? "max-h-48 pt-3 text-sm" : "max-h-72 min-h-[3.5rem]",
        )}
      />

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-3">
        <ModelPicker value={model} onChange={setModel} />

        {/* Slash commands */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Insert slash command"
                >
                  <SlashSquare className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Slash commands</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Slash commands</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {SLASH_COMMANDS.map((cmd) => {
              const Icon = cmd.icon
              return (
                <DropdownMenuItem
                  key={cmd.id}
                  onSelect={() => addCommand(cmd.label)}
                  className="flex items-start gap-2"
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-medium">{cmd.label}</p>
                    <p className="text-xs text-muted-foreground">{cmd.hint}</p>
                  </div>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Effort — only for reasoning-capable models */}
        {canEffort && (
          <Select value={effort} onValueChange={(v) => setEffort(v as EffortLevel)}>
            <SelectTrigger
              size="sm"
              className="h-8 gap-1.5 border-0 bg-transparent px-2 text-xs font-medium shadow-none hover:bg-muted focus-visible:ring-0"
              aria-label={`Reasoning effort: ${effort}`}
            >
              <Brain className="size-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low effort</SelectItem>
              <SelectItem value="medium">Medium effort</SelectItem>
              <SelectItem value="high">High effort</SelectItem>
            </SelectContent>
          </Select>
        )}

        {/* Media-intent toggles — only when the model can produce that media */}
        {canImage && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-pressed={intent === "image"}
                onClick={() => toggleIntent("image")}
                className={cn(
                  "size-8",
                  intent === "image" && "bg-brand/10 text-brand hover:bg-brand/20 hover:text-brand",
                )}
                aria-label="Tag prompt as image generation"
              >
                <ImageIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Generate an image</TooltipContent>
          </Tooltip>
        )}
        {canVideo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-pressed={intent === "video"}
                onClick={() => toggleIntent("video")}
                className={cn(
                  "size-8",
                  intent === "video" && "bg-brand/10 text-brand hover:bg-brand/20 hover:text-brand",
                )}
                aria-label="Tag prompt as video generation"
              >
                <Video className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Generate a video</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Attach file"
            >
              <Paperclip className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Attach file</TooltipContent>
        </Tooltip>

        <div className="ml-auto flex items-center gap-1">
          {/* Improve prompt */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={improvePrompt}
                disabled={!value.trim() || improving}
                className="size-8"
                aria-label="Improve prompt"
              >
                <Sparkles className={cn("size-4", improving && "animate-pulse text-brand")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Improve prompt</TooltipContent>
          </Tooltip>

          <Button
            size="icon"
            className="size-9 shrink-0"
            onClick={submit}
            disabled={!value.trim() && commands.length === 0}
            aria-label="Send"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
