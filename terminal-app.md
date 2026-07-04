# Terminal App — Rust Agentic Coding Terminal (Design Recommendation)

A terminal emulation app with built-in agentic coding — similar to Warp, but usable **only** for agentic coding and related terminal tasks. Own shell environment, beautiful UI, written in Rust.

## The real decision: *be* the terminal vs. run *inside* one

The two options aren't really "Mac app vs CLI binary" — they're two different products:

1. **Native app (you are the terminal)** — like Warp/Ghostty/Zed. You own the window, GPU-render every glyph, and can do proportional fonts, real block-based command UI, inline images, smooth animation, mouse-first interactions. This is the only way to get genuinely "Warp-like beautiful."
2. **TUI binary (you run inside the user's terminal)** — like Claude Code / Codex CLI / Zellij. Instant distribution (`brew install`, one static binary), works over SSH, zero windowing code. But the polish ceiling is the host terminal's cell grid: no proportional text, and fancy stuff (images, synchronized output) depends on the user running Kitty/Ghostty/WezTerm/iTerm2.

The stated differentiator — **"beautiful UI + built-in shell environment, agent-only"** — is a product pitch for the native app. An agent-only *TUI* has weak differentiation against Claude Code/Codex, which already live in the terminal. An agent-only *terminal* (where the shell and the agent share one surface, blocks, and context) is a real wedge.

**Recommendation: build it as a Rust workspace with a UI-agnostic core, and ship the native macOS app with GPUI.** Optionally add a ratatui front-end later for SSH/remote use — the architecture below makes that nearly free.

## Recommended stack (native app path)

### UI framework: GPUI

[GPUI](https://www.gpui.rs/) — Zed's hybrid immediate/retained, GPU-accelerated framework, now usable [standalone from crates.io](https://crates.io/crates/gpui). This is the closest open equivalent to Warp's in-house renderer, and it's proven for exactly this use case: Zed's embedded terminal is GPUI + `alacritty_terminal`, and the [awesome-gpui list](https://github.com/zed-industries/awesome-gpui) already includes `termy`, a GPU-rendered terminal emulator.

- Use [gpui-component](https://github.com/longbridge/gpui-component) (longbridge) for a large ready-made widget set — the "shadcn of GPUI."
- Caveats: pre-1.0, APIs move, docs are thin — you'll read Zed's source as documentation.
- Alternatives if GPUI feels too raw: `iced` (more stable, less "editor-grade") or Tauri (webview — rules itself out on the performance bar).

### Terminal emulation: don't write your own

VT emulation correctness is a multi-year swamp. Embed:

- **`alacritty_terminal`** — the parser + grid state machine from Alacritty; battle-tested, and exactly what Zed embeds. Default choice.
- `wezterm-term` / `termwiz` (WezTerm's crates) — the alternative if broader escape-sequence coverage is needed.
- **`portable-pty`** (from WezTerm) for spawning/managing the shell process cross-platform.

### Warp-style blocks

Implement **shell integration via OSC 133 semantic prompt marks** (FinalTerm protocol, same one Warp/Ghostty/WezTerm use) plus OSC 7 for cwd tracking. That segments scrollback into command blocks the agent can reference, re-run, and attach as context.

This is the single highest-leverage feature for "agent + shell in one surface": every block becomes structured context (command, cwd, exit code, output) you can feed to the model.

### Agent engine (its own crate, no UI deps)

- **Agent protocol:** strongly consider implementing **ACP (Agent Client Protocol — the `agent-client-protocol` crate, from Zed)** so Claude Code, Gemini CLI, etc. can plug in as backends, *in addition to* a native loop. Best-in-class agents on day one while the native loop matures.
- **MCP:** `rmcp` (the official Rust MCP SDK) so users' MCP servers work in the app.
- **LLM calls:** there's no official Anthropic Rust SDK — use `reqwest` + SSE streaming directly (the needed API surface is small: messages, tools, streaming), or a multi-provider crate like `genai` / `rig` for provider switching. Prompt-cache-aware request shaping matters more than the client library.
- **Reference implementation:** OpenAI's Codex CLI is open-source Rust — its `codex-core` crate (agent loop, tool execution, macOS Seatbelt sandboxing for shell commands) is the best existing map of this territory. Study it even if sharing no code.
- **Tooling primitives:** `tree-sitter` for syntax/code structure, `syntect` or tree-sitter highlighting, `ropey` for buffers, and ripgrep's own crates (`grep`, `ignore`, `globset`) for the agent's search tools — same engine as rg, as a library.
- **Runtime:** `tokio` throughout; keep PTY I/O, agent streaming, and render loop on separate tasks with channels.

### Packaging

`cargo-bundle` or `cargo-packager` for the `.app`, plus Apple notarization; distribute via DMG + Homebrew cask. Budget real time for codesigning/notarization CI — fiddly but one-time.

## If choosing the TUI path instead

Still a good product, faster to ship:

- **ratatui + crossterm + tokio** as the base.
- `tui-term` (wraps `vt100`) to embed live shell panes.
- `tui-textarea` for the prompt editor.
- `ratatui-image` for inline images on capable terminals.
- `tachyonfx` for animation polish.
- `termimad` / `tui-markdown` for rendering model output.

The [awesome-ratatui](https://github.com/ratatui/awesome-ratatui) list shows several agent-orchestration TUIs (thurbox, bosun, claudectl) — worth studying, and evidence this space is getting crowded, which supports the native-app differentiation argument.

## Suggested workspace shape

```
crates/
  term-core/     # PTY + alacritty_terminal wrapper, OSC 133 block model
  agent-core/    # agent loop, tools, MCP (rmcp), ACP client, provider clients
  blocks/        # command-block model shared by UI + agent context builder
  app-gpui/      # the macOS app (GPUI + gpui-component)
  app-tui/       # optional later: ratatui front-end over the same cores
```

The discipline that makes this work: `term-core` and `agent-core` never import a UI crate — they expose async streams of events, and each front-end is a renderer over the same state.

## Sources

- [gpui.rs](https://www.gpui.rs/)
- [gpui on crates.io](https://crates.io/crates/gpui)
- [GPUI README](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)
- [awesome-gpui](https://github.com/zed-industries/awesome-gpui)
- [gpui-component](https://github.com/longbridge/gpui-component)
- [ratatui](https://ratatui.rs/)
- [awesome-ratatui](https://github.com/ratatui/awesome-ratatui)
