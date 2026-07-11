# Stella

A fast, BYOK, model-agnostic terminal coding agent built in Rust.

## Set your API key

Stella is bring-your-own-key. Set one or more of these environment variables:

| Provider | Env Var | Default Model |
|---|---|---|
| **Z.ai (GLM 5.2)** | `ZAI_API_KEY` | `glm-5.2` |
| **Anthropic (Claude)** | `ANTHROPIC_API_KEY` | `claude-fable-5` |
| **OpenAI (GPT)** | `OPENAI_API_KEY` | `gpt-5.5` |
| **xAI (Grok)** | `XAI_API_KEY` | `grok-4` |
| **DeepSeek** | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| **Google Gemini** | `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`) | `gemini-3-pro` |
| **OpenRouter** | `OPENROUTER_API_KEY` | `auto` |
| **Google Vertex AI** | `VERTEX_ACCESS_TOKEN` + `VERTEX_PROJECT_ID` | `gemini-3-pro` |
| **Amazon Bedrock** | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |

Vertex AI takes a ready OAuth token (`export VERTEX_ACCESS_TOKEN=$(gcloud auth
print-access-token)`) plus `VERTEX_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) and an
optional `VERTEX_LOCATION` (default `global`). Bedrock uses the standard AWS env
credentials with optional `AWS_SESSION_TOKEN` / `AWS_REGION` (default `us-east-1`);
it is last in auto-detection order so having generic AWS credentials exported never
hijacks provider selection.

Local OpenAI-compatible servers (Ollama, vLLM, LM Studio, llama.cpp server) need no
key at all — point `--base-url` at them:

```bash
stella --model local/llama3.3 --base-url http://localhost:11434/v1
```

```bash
export ZAI_API_KEY=your_key_here
# or
export ANTHROPIC_API_KEY=your_key_here
```

Stella auto-detects which provider to use based on which keys are set.
To pin a specific provider/model, use --model:

```bash
stella --model zai/glm-5.2 run "fix the failing test"
stella --model anthropic/claude-fable-5 chat
```

### Check what is configured

```bash
stella models    # list all providers, their models, and key status
stella config    # show current resolved configuration
```

## Usage

### Interactive chat (default)

```bash
stella
# or
stella chat
```

Starts an interactive REPL. Type your prompt, press Enter. Stella will:
1. Think (with a live spinner)
2. Call tools as needed (read files, run commands, search code)
3. Show its response
4. Display a cost/token summary

**In-chat commands:**
- `/models` - list configured providers and models
- `/config` - show current configuration
- `/clear` - clear conversation history
- `/help` - show help
- `/exit` or Ctrl+D - exit Stella

### One-shot run

```bash
stella run "fix the failing test in src/auth.rs"
stella run "add a health check endpoint to the API"
```

### Pin a model

```bash
stella --model anthropic/claude-fable-5 run "refactor the database layer"
```

## Built-in Tools

| Tool | Description |
|---|---|
| `read_file` | Read a file with line numbers (supports offset/limit) |
| `write_file` | Create or overwrite a file (creates parent dirs) |
| `edit_file` | Replace an exact substring in a file (surgical edits) |
| `bash` | Run a shell command in the workspace root (with timeout) |
| `grep` | Search file contents with regex (shells to ripgrep) |
| `glob` | Find files matching a glob pattern (shells to fd) |

All file tools are workspace-root-pinned. The bash tool runs in the
workspace root with a process-group-based timeout kill.

## Supported Providers

- **Z.ai** (GLM 5.2) - OpenAI-compatible
- **Anthropic** (Claude Fable 5) - Messages API
- **OpenAI** (GPT-5.5) - Responses API
- **xAI** (Grok 4) - OpenAI-compatible
- **DeepSeek** - OpenAI-compatible
- **Google Gemini** - native generateContent (thinking levels, thought
  signatures, cached-token accounting)
- **Google Vertex AI** - native generateContent, project/location-scoped
- **Amazon Bedrock** - Converse API, SigV4-signed
- **OpenRouter** - OpenAI-compatible multi-model gateway
- **Local** - any OpenAI-compatible endpoint via `--model local/<model>
  --base-url <url>` (Ollama, vLLM, LM Studio, llama.cpp server)

Any other OpenAI-compatible gateway (Vercel AI Gateway, Azure OpenAI,
Together, etc.) works the same way through the local provider's
`--base-url`.

## Architecture

stella (oxagen-cli) = CLI binary + agent loop + TUI
  oxagen-tools = read/write/edit/bash/grep/glob
  oxagen-model = Provider trait + adapters (SSE, tool-call dialects)
  oxagen-protocol = Shared serde types
  ocp-types = Open Context Protocol wire types

Key design principles (from docs/specs/oxagen-rust-cli/):
- Ports, not concretions - the engine drives through traits
- No phone-home - zero network calls other than your model provider
- BYOK - any provider key, any combination, no account
- Serde-first - every cross-boundary type is versioned
- Fail loud, recover gracefully - typed errors, never panic

## Development

```bash
cd crates
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p oxagen-cli -- models
```

## License

MIT OR Apache-2.0

## Roadmap
- Phase 0: Workspace skeleton + provider spike (done)
- Phase 1: Built-in tools (done)
- CLI binary: stella with agent loop, REPL, TUI (done)
- Phase 2: Full provider matrix + step-driver + role router
- Phase 3: Local context plane (embeddings, knowledge graph, OCP)
- Phase 5: Fleet, TUI polish, media generation
- Phase 6: Benchmark proof (SWE-bench Verified)
- Phase 7: OSS release (cargo-dist, Homebrew, curl|sh)
