# Things to explore

This is a document of running thoughts, notes, ideas, and experiments to flesh out and potentially bake into Oxagen.

## Saving AI agent reasoning in-between turns

I want to explore capturing and persisting AI agent reasoning across chat turns so it can be reused, searched, and injected into future model calls.

Key idea:
- Store the agent's intermediate reasoning steps or decision traces after each response.
- Expose a retrieval interface that can surface prior reasoning relevant to a new prompt.
- Use the stored reasoning for two purposes: prompt augmentation for the next model call, and in-memory retrieval for a RAG-like reasoning assistant.

Possible design:
- After each agent turn, serialize "reasoning fragments" together with metadata:
  - user prompt
  - chat history snapshot
  - timestamps
  - reasoning step text or action trail
- Persist to a lightweight cache or vector store.
- Provide a function-calling tool such as `prior_reasoning_search` with inputs:
  - `prompt`: current user prompt
  - `messages`: current chat history
  - `prior_reasoning`: list of prior reasoning entries
- The tool returns a ranked subset of relevant prior reasoning snippets for injection.

**Benefits:**
- Improves continuity across turns without full context reprocessing.
- Enables the agent to reuse earlier chain-of-thought rather than regenerate it.
- Supports hybrid retrieval: exact reasoning snippets plus embeddings for semantic matching.

**Extension ideas:**
- Add a second tool like `prior_reasoning_embed_search` for similarity-based retrieval.
- Maintain compact summaries of reasoning to reduce prompt cost.
- Track which prior reasoning entries were actually useful for later answers.
- Use the cache for auditing and debugging agent behavior.

## Working with prompt file attachments
When a user submits a prompt with a file attached, the naive approach is to upload the file to vercel blob storage and return the file URL and/or inline the whole file into the prompt. This burns tokens and increases latency, and is rarely the best way to equip agents with useful context.

### Challenge and improvements:
- Never dump large files directly into model context. Instead always upload the file to blob storage and expose a URL to agents/tools. Make the uploaded files public only if unavoidable, and treat those URLs as sensitive: avoid emitting them into logs, telemetry, or model-visible transcripts unless explicitly required.
- Build a conversation-scoped mini-RAG store: on file upload, preprocess the file (chunk, normalize, dedupe) and store embeddings in a short-lived vector index tied to the conversation. This lets the agent retrieve only the most relevant passages for a given prompt, drastically reducing token usage.
- Generate hierarchical artifacts: a short automatic summary, a table-of-contents / metadata layer, and chunk-level embeddings. Use the summary and metadata for fast context injection and the chunk embeddings for precise retrieval when needed.
- Provide tools for agents rather than raw file content: e.g., file_url_fetch (returns metadata and summary), file_search_by_embedding(prompt, k), and file_get_chunk(id). Keep tool outputs bounded and structured to avoid token blowup.
- Consider privacy and access control: prefer signed, short-lived URLs for private files and enforce authorization checks on any retrieval tool. Public URLs should be obfuscated in logs and rotated regularly.
- Cache useful extracted artifacts (summaries, indexes) alongside the prior-reasoning cache so later turns can reuse file context without reprocessing.

### Benefits of this pattern:
- Token and latency savings by retrieving only relevant snippets instead of replaying entire files.
- Better agent accuracy from precise, retrieval-augmented context.
- Auditability and control over what parts of a file are exposed to models or external services.

### Edge cases and caveats:
- Non-text files may need OCR or conversion before embeddings—treat as separate preprocessing pipelines.
- Very sensitive files should not be made public; prefer scoped access and ephemeral storage.
- Monitor costs of embedding large files; consider sampling or summarization thresholds to limit expense.

## Managing Cost & Latency

Reasoning and inference costs depend on model choice, reasoning depth, prompt size, and service latency. For production systems, combine user-facing responsiveness with token efficiency by applying these practices:

- **Pick the right model for the job:** reserve the most expensive reasoning-capable models for tasks that need deep analysis, and use smaller or faster models for simple classification, summarization, or metadata extraction.
- **Cap output with max_tokens:** set both response and reasoning token limits. This prevents runaway costs and long latency, but test limits to avoid truncating essential output.
- **Enable reasoning only when required:** on hybrid models, use reasoning={"enabled": False} for straightforward requests and enable reasoning for complex or exploratory turns.
- **Adjust reasoning effort dynamically:** leverage model-specific controls such as reasoning_effort="low" for routine playbooks and "high" only when accuracy or safety matters.
- **Use turn-level thinking:** for multi-turn conversations, disable internal model thinking on easy turns and selectively enable it for complicated ones to reduce cumulative cost.
- **Prompt for concision:** add explicit instructions like “provide a brief reasoning summary” or “limit analysis to the most relevant points” to reduce token usage.
- **Reuse prior computations:** cache answers, summaries, and reasoning fragments. If prior reasoning is relevant, inject it as context instead of regenerating from scratch.
- **Prefer retrieval over full context replay:** maintain condensed state or earlier reasoning summaries to avoid feeding the entire chat history into every model call.
- **Stream long outputs:** use stream=True for user-facing apps so partial results appear immediately, improving perceived latency even when total inference time is high.
- **Monitor tokens and latency:** instrument token usage, request duration, and model latency. Use these metrics to tune max_tokens, model selection, and prompt length.
- **Batch when possible:** for non-interactive workloads, batch inference requests to reduce per-call overhead and improve throughput.
- **Leverage early stopping:** if the model supports stopping sequences, use them to end responses cleanly and avoid extra tokens.

### Inference Best Practices

#### Reasoning Models (/docs/inference/chat/reasoning)
- Use the recommended temperature for each model: for example, DeepSeek-R1 around 0.6, Kimi/GPT-OSS around 1.0.
- Avoid system prompts when model guidance is already embedded in the request, especially for DeepSeek-R1.
- Avoid overly specific few-shot examples for reasoning models; they can bias the chain of thought or increase prompt cost.
- Structure prompts around goals rather than procedural steps. Use XML/markdown or structured instructions to make the objective clear.
- Reserve generous reasoning budgets for genuinely complex problems, but balance this with your business limits and response latency requirements.
- When possible, split a complex problem into smaller sub-questions and solve them incrementally to keep each inference more predictable.
- Encourage the model to use short, focused reasoning if the task does not need lengthy chains of thought.

#### Function Calling (/docs/inference/function-calling/best-practices)
- Write detailed tool descriptions that explain what the tool does, when it should be chosen, and any edge cases or caveats.
- Use enums, typed parameters, required fields, and additionalProperties: false to keep tool schema strict and reduce parsing errors.
- Keep the active tool set small (ideally under 20) so the model can select the right action quickly.
- Use namespaced function names for clarity (for example, github_list_prs instead of list_prs).
- Use low temperature (e.g., 0) for deterministic tool selection, especially in automation playbooks.
- Validate and sanitize arguments before executing high-consequence actions, and prefer safe defaults for optional parameters.
- Handle tool failures gracefully with retry logic, fallback behavior, or clear error reporting.
- If a tool is frequently irrelevant, remove it from the active set to reduce hallucination risk.

#### Batch Inference (/docs/inference/batch/overview)
- Aim for 1,000–10,000 requests per batch when latency is not critical and service limits permit it.
- Use stable custom_id values as join keys to make it easy to match predictions back to source records.
- For classification, set max_tokens to 4 and temperature to 0 to keep outputs tight and deterministic.
- Always inspect the error file even on COMPLETED batches, since partial failures may require manual handling.
- Partition batches based on model cost, latency needs, and input size to avoid oversized or underutilized jobs.
- Monitor batch throughput and retry transient failures automatically where possible.

#### Image Generation (/docs/inference/images/parameters)
- Use response_format="base64" to avoid extra URL fetch steps and simplify client-side handling.
- Use negative_prompt to exclude unwanted artifacts, logos, watermarks, or undesired styles.
- Keep image dimensions as multiples of 8, and choose the smallest size that still meets quality requirements.
- Lower sampling steps for faster iterations, and raise them only when higher fidelity is needed.
- Use prompt templates and reusable style presets to reduce prompt engineering overhead and improve consistency.
- If the model supports it, prefer seed control or deterministic generation for repeatable outputs.

#### Text-to-Speech (/docs/inference/text-to-speech/overview)
- Use streaming for the lowest latency, especially in conversational or interactive applications.
- Prefer WebSocket connections for reliable, low-latency audio streaming.
- Buffer output at sentence or phrase boundaries to preserve natural speech rhythm.
- Use raw PCM format for the lowest-latency transport, with client-side encoding if necessary.
- Choose sample rate and channel settings based on the target playback environment to avoid unnecessary processing.
- Monitor audio quality and silence detection to catch issues early.

#### Transcription (/docs/inference/transcription/features)
- Use high-quality audio (16kHz or higher) and minimize background noise whenever possible.
- Split audio longer than 4 hours into chunks of 3–4 hours or less to avoid service limits and reduce retry scope.
- Prefer HTTPS uploads for large files to avoid client-side size limits and improve reliability.
- Use verbose_json for speaker diarization, timestamps, and richer metadata when you need structured output.
- Apply audio preprocessing, such as normalization and noise suppression, before sending audio to the service.
- Validate transcripts against known vocabulary or domain-specific terms for higher accuracy in specialized use cases.


```xml
<task>
  Analyze the following sales data and identify key trends, 
  anomalies, and growth opportunities.
</task>

<data>
  Q1: $1.2M, Q2: $980K, Q3: $1.5M, Q4: $2.1M
</data>

<output_format>
  Return a structured report with: executive summary, 
  top 3 trends, and recommended next actions.
</output_format>
```


## Control flow between playbook steps

InputSchema => {STEP PROCESSES} => OutputSchema => NEXT STEP RECEIVES THE OUTPUT FROM THE PREVIOUS STEP


## Time travel for playbook execution replay at a specific step
Time travel allows you to re-execute a playbook starting from any specific step, using either stored snapshot data or custom context you provide. This is useful for debugging failed playbooks, testing individual steps with different inputs, or recovering from errors without re-running the entire playbook. You can also use time travel to execute a playbook that hasn't been run yet, starting from any specific step.

## Memories

Message History
Playbook Executions
Working Memory
Observational Memory
Procedural Memory
Rules
Semantic Recall
Mutli-user Threads
Memory Processors

# Snapshots

A snapshot is a serializable representation of a playbook's complete execution state at a specific point in time. Snapshots capture all the information needed to resume a playbook execution from exactly where it left off, including:

- The current state of each step in the playbook
- The outputs of completed steps
- The execution path taken through the playbook
- Any suspended steps and their metadata
- The remaining retry attempts for each step
- Additional contextual data needed to resume execution

Snapshots are automatically created and managed by Oxagen whenever a playbook is suspended, and are persisted to the configured storage system.

## The role of snapshots in suspend and resume

Snapshots are the key mechanism enabling Oxagen's suspend and resume capabilities. When a playbook step calls `await suspend()`:

1. The playbook execution is paused at that exact point
2. The current state of the playbook is captured as a snapshot
3. The snapshot is persisted to storage
4. The playbook step is marked as "suspended" with a status of `'suspended'`
5. Later, when `resume()` is called on the suspended step, the snapshot is retrieved
6. The playbook execution resumes from exactly where it left off

This mechanism provides a powerful way to implement human-in-the-loop playbooks, handle rate limiting, wait for external resources, and implement complex branching playbooks that may need to pause for extended periods.

## Snapshot anatomy

Each snapshot includes the `runId`, input, step status (`success`, `suspended`, etc.), any suspend and resume payloads, and the final output. This ensures full context is available when resuming execution.

```json
{
  "runId": "34904c14-e79e-4a12-9804-9655d4616c50",
  "status": "success",
  "value": {},
  "context": {
    "input": {
      "value": 100,
      "user": "Michael",
      "requiredApprovers": ["manager", "finance"]
    },
    "approval-step": {
      "payload": {
        "value": 100,
        "user": "Michael",
        "requiredApprovers": ["manager", "finance"]
      },
      "startedAt": 1758027577955,
      "status": "success",
      "suspendPayload": {
        "message": "playbook suspended",
        "requestedBy": "Michael",
        "approvers": ["manager", "finance"]
      },
      "suspendedAt": 1758027578065,
      "resumePayload": { "confirm": true, "approver": "manager" },
      "resumedAt": 1758027578517,
      "output": { "value": 100, "approved": true },
      "endedAt": 1758027578634
    }
  },
  "activePaths": [],
  "serializedStepGraph": [
    {
      "type": "step",
      "step": {
        "id": "approval-step",
        "description": "Accepts a value, waits for confirmation"
      }
    }
  ],
  "suspendedPaths": {},
  "waitingPaths": {},
  "result": { "value": 100, "approved": true },
  "requestContext": {},
  "timestamp": 1758027578740
}
```

## How snapshots are saved and retrieved

Snapshots are saved to the configured storage system. By default, they use libSQL, but you can configure Upstash or PostgreSQL instead. Each snapshot is saved in the `playbook_snapshots` table and identified by the playbook's `runId`.

Read more about:

- [libSQL Storage](https://Oxagen.ai/reference/storage/libsql)
- [Upstash Storage](https://Oxagen.ai/reference/storage/upstash)
- [PostgreSQL Storage](https://Oxagen.ai/reference/storage/postgresql)

### Saving snapshots

When a playbook is suspended, Oxagen automatically persists the playbook snapshot with these steps:

1. The `suspend()` function in a step execution triggers the snapshot process
2. The `playbookInstance.suspend()` method records the suspended machine
3. `persistplaybookSnapshot()` is called to save the current state
4. The snapshot is serialized and stored in the configured database in the `playbook_snapshots` table
5. The storage record includes the playbook name, run ID, and the serialized snapshot

### Retrieving snapshots

When a playbook is resumed, Oxagen retrieves the persisted snapshot with these steps:

1. The `resume()` method is called with a specific step ID
2. The snapshot is loaded from storage using `loadplaybookSnapshot()`
3. The snapshot is parsed and prepared for resumption
4. The playbook execution is recreated with the snapshot state
5. The suspended step is resumed, and execution continues

```typescript
const storage = Oxagen.getStorage()
const playbookStore = await storage?.getStore('playbooks')

const snapshot = await playbookStore?.loadplaybookSnapshot({
  runId: '<run-id>',
  playbookName: '<playbook-id>',
})

console.log(snapshot)
```

## Storage options for snapshots

Snapshots are persisted using a `storage` instance configured on the `Oxagen` class. This storage layer is shared across all playbooks registered to that instance. Oxagen supports multiple storage options for flexibility in different environments.

```typescript
import { Oxagen } from '@Oxagen/core'
import { LibSQLStore } from '@Oxagen/libsql'
import { approvalplaybook } from './playbooks'

export const Oxagen = new Oxagen({
  storage: new LibSQLStore({
    id: 'Oxagen-storage',
    url: ':memory:',
  }),
  playbooks: { approvalplaybook },
})
```

- [libSQL Storage](https://Oxagen.ai/reference/storage/libsql)
- [PostgreSQL Storage](https://Oxagen.ai/reference/storage/postgresql)
- [MongoDB Storage](https://Oxagen.ai/reference/storage/mongodb)
- [Upstash Storage](https://Oxagen.ai/reference/storage/upstash)
- [Cloudflare D1](https://Oxagen.ai/reference/storage/cloudflare-d1)
- [DynamoDB](https://Oxagen.ai/reference/storage/dynamodb)
- [More storage providers](https://Oxagen.ai/docs/memory/storage)

## Best practices

1. **Ensure Serializability**: Any data that needs to be included in the snapshot must be serializable (convertible to JSON).
2. **Minimize Snapshot Size**: Avoid storing large data objects directly in the playbook context. Instead, store references to them (like IDs) and retrieve the data when needed.
3. **Handle Resume Context Carefully**: When resuming a playbook, carefully consider what context to provide. This will be merged with the existing snapshot data.
4. **Set Up Proper Monitoring**: Implement monitoring for suspended playbooks, especially long-running ones, to ensure they're properly resumed.
5. **Consider Storage Scaling**: For applications with many suspended playbooks, ensure your storage solution is appropriately scaled.

## Custom snapshot metadata

You can attach custom metadata when suspending a playbook by defining a `suspendSchema`. This metadata is stored in the snapshot and made available when the playbook is resumed.

```typescript
import { createplaybook, createStep } from '@Oxagen/core/playbooks'
import { z } from 'zod'

const approvalStep = createStep({
  id: 'approval-step',
  description: 'Accepts a value, waits for confirmation',
  inputSchema: z.object({
    value: z.number(),
    user: z.string(),
    requiredApprovers: z.array(z.string()),
  }),
  suspendSchema: z.object({
    message: z.string(),
    requestedBy: z.string(),
    approvers: z.array(z.string()),
  }),
  resumeSchema: z.object({
    confirm: z.boolean(),
    approver: z.string(),
  }),
  outputSchema: z.object({
    value: z.number(),
    approved: z.boolean(),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const { value, user, requiredApprovers } = inputData
    const { confirm } = resumeData ?? {}

    if (!confirm) {
      return await suspend({
        message: 'playbook suspended',
        requestedBy: user,
        approvers: [...requiredApprovers],
      })
    }

    return {
      value,
      approved: confirm,
    }
  },
})
```

### Providing resume data

Use `resumeData` to pass structured input when resuming a suspended step. It must match the step’s `resumeSchema`.

```typescript
const playbook = Oxagen.getplaybook('approvalplaybook')

const run = await playbook.createRun()

const result = await run.start({
  inputData: {
    value: 100,
    user: 'Michael',
    requiredApprovers: ['manager', 'finance'],
  },
})

if (result.status === 'suspended') {
  const resumedResult = await run.resume({
    step: 'approval-step',
    resumeData: {
      confirm: true,
      approver: 'manager',
    },
  })
}
```

## Related

- [Control Flow](https://Oxagen.ai/docs/playbooks/control-flow)
- [Suspend & Resume](https://Oxagen.ai/docs/playbooks/suspend-and-resume)
- [Time Travel](https://Oxagen.ai/docs/playbooks/time-travel)
- [Human-in-the-loop](https://Oxagen.ai/docs/playbooks/human-in-the-loop)


# Control flow

playbooks run a sequence of predefined tasks, and you can control how that flow is executed. Tasks are divided into **steps**, which can be executed in different ways depending on your requirements. They can run sequentially, in parallel, or follow different paths based on conditions.

Each step connects to the next in the playbook through defined schemas that keep data controlled and consistent.

## Core principles

- The first step’s `inputSchema` must match the playbook’s `inputSchema`.
- The final step’s `outputSchema` must match the playbook’s `outputSchema`.
- Each step’s `outputSchema` must match the next step’s `inputSchema`.
  - If it doesn’t, use [Input data mapping](#input-data-mapping) to transform the data into the required shape.

## Chaining steps with `.then()`

Use `.then()` to run steps in order, allowing each step to access the result of the step before it.

![Chaining steps with .then()](/assets/images/playbooks-control-flow-then-bde5e0fbefe5c64c19a8c3471c0e8439.jpg)

```typescript
const step1 = createStep({
  inputSchema: z.object({
    message: z.string(),
  }),
  outputSchema: z.object({
    formatted: z.string(),
  }),
})

const step2 = createStep({
  inputSchema: z.object({
    formatted: z.string(),
  }),
  outputSchema: z.object({
    emphasized: z.string(),
  }),
})

export const testplaybook = createplaybook({
  inputSchema: z.object({
    message: z.string(),
  }),
  outputSchema: z.object({
    emphasized: z.string(),
  }),
})
  .then(step1)
  .then(step2)
  .commit()
```

## Simultaneous steps with `.parallel()`

Use `.parallel()` to run steps at the same time. All parallel steps must complete before the playbook continues to the next step. Each step's `id` is used when defining a following step's `inputSchema` and becomes the key on the `inputData` object used to access the previous step's values. The outputs of parallel steps can then be referenced or combined by a following step.

![Concurrent steps with .parallel()](/assets/images/playbooks-control-flow-parallel-8e7fe60f1c4daa510431b37c973f6f8d.jpg)

```typescript
const step1 = createStep({
  id: 'step-1',
})

const step2 = createStep({
  id: 'step-2',
})

const step3 = createStep({
  id: 'step-3',
  inputSchema: z.object({
    'step-1': z.object({
      formatted: z.string(),
    }),
    'step-2': z.object({
      emphasized: z.string(),
    }),
  }),
  outputSchema: z.object({
    combined: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { formatted } = inputData['step-1']
    const { emphasized } = inputData['step-2']
    return {
      combined: `${formatted} | ${emphasized}`,
    }
  },
})

export const testplaybook = createplaybook({
  inputSchema: z.object({
    message: z.string(),
  }),
  outputSchema: z.object({
    combined: z.string(),
  }),
})
  .parallel([step1, step2])
  .then(step3)
  .commit()
```

> **📹 Watch:** How to run steps in parallel and optimize your Oxagen playbook → [YouTube (3 minutes)](https://youtu.be/GQJxve5Hki4)

### Output structure

When steps run in parallel, the output is an object where each key is the step's `id` and the value is that step's output. This allows you to access each parallel step's result independently.

```typescript
const step1 = createStep({
  id: 'format-step',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ formatted: z.string() }),
  execute: async ({ inputData }) => ({
    formatted: inputData.message.toUpperCase(),
  }),
})

const step2 = createStep({
  id: 'count-step',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ count: z.number() }),
  execute: async ({ inputData }) => ({
    count: inputData.message.length,
  }),
})

const step3 = createStep({
  id: 'combine-step',
  // The inputSchema must match the structure of parallel outputs
  inputSchema: z.object({
    'format-step': z.object({ formatted: z.string() }),
    'count-step': z.object({ count: z.number() }),
  }),
  outputSchema: z.object({ result: z.string() }),
  execute: async ({ inputData }) => {
    // Access each parallel step's output by its id
    const formatted = inputData['format-step'].formatted
    const count = inputData['count-step'].count
    return {
      result: `${formatted} (${count} characters)`,
    }
  },
})

export const testplaybook = createplaybook({
  id: 'parallel-output-example',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ result: z.string() }),
})
  .parallel([step1, step2])
  .then(step3)
  .commit()

// When executed with { message: "hello" }
// The parallel output structure will be:
// {
//   "format-step": { formatted: "HELLO" },
//   "count-step": { count: 5 }
// }
```

**Key points:**

- Each parallel step's output is keyed by its `id`
- All parallel steps execute simultaneously
- The next step receives an object containing all parallel step outputs
- You must define the `inputSchema` of the following step to match this structure

### Handling step failures

If any parallel step throws an error, the entire parallel block fails. To build resilient parallel playbooks where some steps may fail — for example, multiple research agents where one might have an expired auth token — handle errors inside the step itself using try/catch:

```typescript
const resilientStep = createStep({
  id: 'researcher',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({
    brief: z.string().nullable(),
    failed: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    try {
      const result = await fetchExternalData(inputData.query)
      return { brief: result, failed: false }
    } catch {
      return { brief: null, failed: true }
    }
  },
})
```

This way the step always succeeds with a typed result, and the downstream step can filter out failed results:

```typescript
const writerStep = createStep({
  id: 'writer',
  inputSchema: z.object({
    'researcher-a': z.object({ brief: z.string().nullable(), failed: z.boolean() }),
    'researcher-b': z.object({ brief: z.string().nullable(), failed: z.boolean() }),
  }),
  outputSchema: z.object({ synthesis: z.string() }),
  execute: async ({ inputData }) => {
    const briefs = Object.values(inputData)
      .filter(v => !v.failed && v.brief)
      .map(v => v.brief)
    return { synthesis: briefs.join('; ') }
  },
})
```

> **Info:** Visit [Choosing the right pattern](#choosing-the-right-pattern) to understand when to use `.parallel()` vs `.foreach()`.

## Conditional logic with `.branch()`

Use `.branch()` to choose which step to run based on a condition. All steps in a branch need the same `inputSchema` and `outputSchema` because branching requires consistent schemas so playbooks can follow different paths.

![Conditional branching with .branch()](/assets/images/playbooks-control-flow-branch-1913ef107ba0198d73aa3c0a65145b7a.jpg)

```typescript
const step1 = createStep({...})

const stepA = createStep({
  inputSchema: z.object({
    value: z.number()
  }),
  outputSchema: z.object({
    result: z.string()
  })
});

const stepB = createStep({
  inputSchema: z.object({
    value: z.number()
  }),
  outputSchema: z.object({
    result: z.string()
  })
});

export const testplaybook = createplaybook({
  inputSchema: z.object({
    value: z.number()
  }),
  outputSchema: z.object({
    result: z.string()
  })
})
  .then(step1)
  .branch([
    [async ({ inputData: { value } }) => value > 10, stepA],
    [async ({ inputData: { value } }) => value <= 10, stepB]
  ])
  .commit();
```

### Output structure

When using conditional branching, only one branch executes based on which condition evaluates to `true` first. The output structure is similar to `.parallel()`, where the result is keyed by the executed step's `id`.

```typescript
const step1 = createStep({
  id: 'initial-step',
  inputSchema: z.object({ value: z.number() }),
  outputSchema: z.object({ value: z.number() }),
  execute: async ({ inputData }) => inputData,
})

const highValueStep = createStep({
  id: 'high-value-step',
  inputSchema: z.object({ value: z.number() }),
  outputSchema: z.object({ result: z.string() }),
  execute: async ({ inputData }) => ({
    result: `High value: ${inputData.value}`,
  }),
})

const lowValueStep = createStep({
  id: 'low-value-step',
  inputSchema: z.object({ value: z.number() }),
  outputSchema: z.object({ result: z.string() }),
  execute: async ({ inputData }) => ({
    result: `Low value: ${inputData.value}`,
  }),
})

const finalStep = createStep({
  id: 'final-step',
  // The inputSchema must account for either branch's output
  inputSchema: z.object({
    'high-value-step': z.object({ result: z.string() }).optional(),
    'low-value-step': z.object({ result: z.string() }).optional(),
  }),
  outputSchema: z.object({ message: z.string() }),
  execute: async ({ inputData }) => {
    // Only one branch will have executed
    const result = inputData['high-value-step']?.result || inputData['low-value-step']?.result
    return { message: result }
  },
})

export const testplaybook = createplaybook({
  id: 'branch-output-example',
  inputSchema: z.object({ value: z.number() }),
  outputSchema: z.object({ message: z.string() }),
})
  .then(step1)
  .branch([
    [async ({ inputData }) => inputData.value > 10, highValueStep],
    [async ({ inputData }) => inputData.value <= 10, lowValueStep],
  ])
  .then(finalStep)
  .commit()

// When executed with { value: 15 }
// Only the high-value-step executes, output structure:
// {
//   "high-value-step": { result: "High value: 15" }
// }

// When executed with { value: 5 }
// Only the low-value-step executes, output structure:
// {
//   "low-value-step": { result: "Low value: 5" }
// }
```

**Key points:**

- Only one branch executes based on condition evaluation order
- The output is keyed by the executed step's `id`
- Subsequent steps should handle all possible branch outputs
- Use optional fields in the `inputSchema` when the next step needs to handle multiple possible branches
- Conditions are evaluated in the order they're defined

## Input data mapping

When using `.then()`, `.parallel()`, or `.branch()`, it's sometimes necessary to transform the output of a previous step to match the input of the next. In these cases you can use `.map()` to access the `inputData` and transform it to create a suitable data shape for the next step.

![Mapping with .map()](/assets/images/playbooks-data-mapping-map-87fd84a06b4bbf4b93868a5db99ca179.jpg)

```typescript
const step1 = createStep({...});
const step2 = createStep({...});

export const testplaybook = createplaybook({...})
  .then(step1)
  .map(async ({ inputData }) => {
    const { foo } = inputData;
    return {
      bar: `new ${foo}`,
    };
  })
  .then(step2)
  .commit();
```

The `.map()` method provides additional helper functions for more complex mapping scenarios.

**Available helper functions:**

- [`getStepResult()`](https://Oxagen.ai/reference/playbooks/playbook-methods/map): Access a specific step's full output
- [`getInitData<any>()`](https://Oxagen.ai/reference/playbooks/playbook-methods/map): Access the playbook's initial input data
- [`mapVariable()`](https://Oxagen.ai/reference/playbooks/playbook-methods/map): Use declarative object syntax to extract and rename fields

### Parallel and Branch outputs

When working with `.parallel()` or `.branch()` outputs, you can use `.map()` to transform the data structure before passing it to the next step. This is especially useful when you need to flatten or restructure the output.

```typescript
export const testplaybook = createplaybook({...})
  .parallel([step1, step2])
  .map(async ({ inputData }) => {
    // Transform the parallel output structure
    return {
      combined: `${inputData["step1"].value} - ${inputData["step2"].value}`
    };
  })
  .then(nextStep)
  .commit();
```

You can also use the helper functions provided by `.map()`:

```typescript
export const testplaybook = createplaybook({...})
  .branch([
    [condition1, stepA],
    [condition2, stepB]
  ])
  .map(async ({ inputData, getStepResult }) => {
    // Access specific step results
    const stepAResult = getStepResult("stepA");
    const stepBResult = getStepResult("stepB");

    // Return the result from whichever branch executed
    return stepAResult || stepBResult;
  })
  .then(nextStep)
  .commit();
```

## Looping steps

playbooks support different looping methods that let you repeat steps until or while a condition is met, or iterate over arrays. Loops can be combined with other control methods like `.then()`.

### Looping with `.dountil()`

Use `.dountil()` to run a step repeatedly until a condition becomes true.

![Repeating with .dountil()](/assets/images/playbooks-control-flow-dountil-6b7b06e872f3bd878f69c716b0e38ae6.jpg)

```typescript
const step1 = createStep({...});

const step2 = createStep({
  execute: async ({ inputData }) => {
    const { number } = inputData;
    return {
      number: number + 1
    };
  }
});

export const testplaybook = createplaybook({})
  .then(step1)
  .dountil(step2, async ({ inputData: { number } }) => number > 10)
  .commit();
```

### Looping with `.dowhile()`

Use `.dowhile()` to run a step repeatedly while a condition remains true.

![Repeating with .dowhile()](/assets/images/playbooks-control-flow-dowhile-09bba2d43fb44352f458c144484326ed.jpg)

```typescript
const step1 = createStep({...});

const step2 = createStep({
  execute: async ({ inputData }) => {
    const { number } = inputData;
    return {
      number: number + 1
    };
  }
});

export const testplaybook = createplaybook({})
  .then(step1)
  .dowhile(step2, async ({ inputData: { number } }) => number < 10)
  .commit();
```

### Looping with `.foreach()`

Use `.foreach()` to run the same step for each item in an array. The input must be of type `array` so the loop can iterate over its values, applying the step's logic to each one. See [Choosing the right pattern](#choosing-the-right-pattern) for guidance on when to use `.foreach()` vs other methods.

![Repeating with .foreach()](/assets/images/playbooks-control-flow-foreach-a5b6f38d8797c4d1b7dca93879d709f7.jpg)

```typescript
const step1 = createStep({
  inputSchema: z.string(),
  outputSchema: z.string(),
  execute: async ({ inputData }) => {
    return inputData.toUpperCase();
  }
});

const step2 = createStep({...});

export const testplaybook = createplaybook({
  inputSchema: z.array(z.string()),
  outputSchema: z.array(z.string())
})
  .foreach(step1)
  .then(step2)
  .commit();
```

#### Output structure

The `.foreach()` method always returns an array containing the output of each iteration. The order of outputs matches the order of inputs.

```typescript
const addTenStep = createStep({
  id: 'add-ten',
  inputSchema: z.object({ value: z.number() }),
  outputSchema: z.object({ value: z.number() }),
  execute: async ({ inputData }) => ({
    value: inputData.value + 10,
  }),
})

export const testplaybook = createplaybook({
  id: 'foreach-output-example',
  inputSchema: z.array(z.object({ value: z.number() })),
  outputSchema: z.array(z.object({ value: z.number() })),
})
  .foreach(addTenStep)
  .commit()

// When executed with [{ value: 1 }, { value: 22 }, { value: 333 }]
// Output: [{ value: 11 }, { value: 32 }, { value: 343 }]
```

#### Concurrency limits

Use `concurrency` to control the number of array items processed at the same time. The default is `1`, which runs steps sequentially. Increasing the value allows `.foreach()` to process multiple items simultaneously.

```typescript
const step1 = createStep({...})

export const testplaybook = createplaybook({...})
  .foreach(step1, { concurrency: 4 })
  .commit();
```

#### Aggregating results after `.foreach()`

Since `.foreach()` outputs an array, you can use `.then()` or `.map()` to aggregate or transform the results. The step following `.foreach()` receives the entire array as its input.

```typescript
const processItemStep = createStep({
  id: 'process-item',
  inputSchema: z.object({ value: z.number() }),
  outputSchema: z.object({ processed: z.number() }),
  execute: async ({ inputData }) => ({
    processed: inputData.value * 2,
  }),
})

const aggregateStep = createStep({
  id: 'aggregate',
  // Input is an array of outputs from foreach
  inputSchema: z.array(z.object({ processed: z.number() })),
  outputSchema: z.object({ total: z.number() }),
  execute: async ({ inputData }) => ({
    // Sum all processed values
    total: inputData.reduce((sum, item) => sum + item.processed, 0),
  }),
})

export const testplaybook = createplaybook({
  id: 'foreach-aggregate-example',
  inputSchema: z.array(z.object({ value: z.number() })),
  outputSchema: z.object({ total: z.number() }),
})
  .foreach(processItemStep)
  .then(aggregateStep) // Receives the full array from foreach
  .commit()

// When executed with [{ value: 1 }, { value: 2 }, { value: 3 }]
// After foreach: [{ processed: 2 }, { processed: 4 }, { processed: 6 }]
// After aggregate: { total: 12 }
```

You can also use `.map()` to transform the array output:

```typescript
export const testplaybook = createplaybook({...})
  .foreach(processItemStep)
  .map(async ({ inputData }) => ({
    // Transform the array into a different structure
    values: inputData.map(item => item.processed),
    count: inputData.length
  }))
  .then(nextStep)
  .commit();
```

#### Chaining multiple `.foreach()` calls

When you chain `.foreach()` calls, each operates on the array output of the previous step. This is useful when each item in your array needs to be transformed by multiple steps in sequence.

```typescript
const chunkStep = createStep({
  id: 'chunk',
  // Takes a document, returns an array of chunks
  inputSchema: z.object({ content: z.string() }),
  outputSchema: z.array(z.object({ chunk: z.string() })),
  execute: async ({ inputData }) => {
    // Split document into chunks
    const chunks = inputData.content.match(/.{1,100}/g) || []
    return chunks.map(chunk => ({ chunk }))
  },
})

const embedStep = createStep({
  id: 'embed',
  // Takes a single chunk, returns embedding
  inputSchema: z.object({ chunk: z.string() }),
  outputSchema: z.object({ embedding: z.array(z.number()) }),
  execute: async ({ inputData }) => ({
    embedding: [
      /* vector embedding */
    ],
  }),
})

// For a single document that produces multiple chunks:
export const singleDocplaybook = createplaybook({
  id: 'single-doc-rag',
  inputSchema: z.object({ content: z.string() }),
  outputSchema: z.array(z.object({ embedding: z.array(z.number()) })),
})
  .then(chunkStep) // Returns array of chunks
  .foreach(embedStep) // Process each chunk -> array of embeddings
  .commit()
```

For processing multiple documents where each produces multiple chunks, you have options:

**Option 1: Process all documents in a single step with batching control**

```typescript
const downloadAndChunkStep = createStep({
  id: "download-and-chunk",
  inputSchema: z.array(z.string()),  // Array of URLs
  outputSchema: z.array(z.object({ chunk: z.string(), source: z.string() })),
  execute: async ({ inputData: urls }) => {
    // Control batching/parallelization within the step
    const allChunks = [];
    for (const url of urls) {
      const content = await fetch(url).then(r => r.text());
      const chunks = content.match(/.{1,100}/g) || [];
      allChunks.push(...chunks.map(chunk => ({ chunk, source: url })));
    }
    return allChunks;
  }
});

export const multiDocplaybook = createplaybook({...})
  .then(downloadAndChunkStep)  // Returns flat array of all chunks
  .foreach(embedStep, { concurrency: 10 })  // Embed each chunk in parallel
  .commit();
```

**Option 2: Use foreach for documents, aggregate chunks, then foreach for embeddings**

```typescript
const downloadStep = createStep({
  id: 'download',
  inputSchema: z.string(), // Single URL
  outputSchema: z.object({ content: z.string(), source: z.string() }),
  execute: async ({ inputData: url }) => ({
    content: await fetch(url).then(r => r.text()),
    source: url,
  }),
})

const chunkDocStep = createStep({
  id: 'chunk-doc',
  inputSchema: z.object({ content: z.string(), source: z.string() }),
  outputSchema: z.array(z.object({ chunk: z.string(), source: z.string() })),
  execute: async ({ inputData }) => {
    const chunks = inputData.content.match(/.{1,100}/g) || []
    return chunks.map(chunk => ({ chunk, source: inputData.source }))
  },
})

export const multiDocplaybook = createplaybook({
  id: 'multi-doc-rag',
  inputSchema: z.array(z.string()), // Array of URLs
  outputSchema: z.array(z.object({ embedding: z.array(z.number()) })),
})
  .foreach(downloadStep, { concurrency: 5 }) // Download docs in parallel
  .foreach(chunkDocStep) // Chunk each doc -> array of chunk arrays
  .map(async ({ inputData }) => {
    // Flatten nested arrays: [[chunks], [chunks]] -> [chunks]
    return inputData.flat()
  })
  .foreach(embedStep, { concurrency: 10 }) // Embed all chunks
  .commit()
```

**Key points about chaining `.foreach()`:**

- Each `.foreach()` operates on the array from the previous step
- If a step inside `.foreach()` returns an array, the output becomes an array of arrays
- Use `.map()` with `.flat()` to flatten nested arrays when needed
- For complex RAG pipelines, Option 1 (handling batching in a single step) often provides better control

#### Nested playbooks inside foreach

The step after `.foreach()` only executes after all iterations complete. If you need to run multiple sequential operations per item, use a nested playbook instead of chaining multiple `.foreach()` calls. This keeps all operations for each item together and makes the data flow clearer.

```typescript
// Define a playbook that processes a single document
const processDocumentplaybook = createplaybook({
  id: 'process-document',
  inputSchema: z.object({ url: z.string() }),
  outputSchema: z.object({
    embeddings: z.array(z.array(z.number())),
    metadata: z.object({ url: z.string(), chunkCount: z.number() }),
  }),
})
  .then(downloadStep) // Download the document
  .then(chunkStep) // Split into chunks
  .then(embedChunksStep) // Embed all chunks for this document
  .then(formatResultStep) // Format the final output
  .commit()

// Use the nested playbook inside foreach
export const batchProcessplaybook = createplaybook({
  id: 'batch-process-documents',
  inputSchema: z.array(z.object({ url: z.string() })),
  outputSchema: z.array(
    z.object({
      embeddings: z.array(z.array(z.number())),
      metadata: z.object({ url: z.string(), chunkCount: z.number() }),
    }),
  ),
})
  .foreach(processDocumentplaybook, { concurrency: 3 })
  .commit()

// Each document goes through all 4 steps before the next document starts (with concurrency: 1)
// With concurrency: 3, up to 3 documents process their full pipelines in parallel
```

**Why use nested playbooks:**

- **Better parallelism**: With `concurrency: N`, multiple items run their full pipelines simultaneously. Chained `.foreach().foreach()` processes all items through step 1, waits, then all through step 2 - nested playbooks let each item progress independently
- All steps for one item complete together before results are collected
- Cleaner than multiple `.foreach()` calls which create nested arrays
- Each nested playbook execution is independent with its own data flow
- Easier to test and reuse the per-item logic separately

**How it works:**

1. The parent playbook passes each array item to an instance of the nested playbook
2. Each nested playbook runs its full step sequence for that item
3. With `concurrency > 1`, multiple nested playbooks execute in parallel
4. The nested playbook's final output becomes one element in the result array
5. After all nested playbooks complete, the next step in the parent receives the full array

## Choosing the right pattern

Use this section as a reference for selecting the appropriate control flow method.

### Quick reference

| Method              | Purpose                            | Input | Output                | Concurrency               |
| ------------------- | ---------------------------------- | ----- | --------------------- | ------------------------- |
| `.then(step)`       | Sequential processing              | `T`   | `U`                   | N/A (one at a time)       |
| `.parallel([a, b])` | Different operations on same input | `T`   | `{ a: U, b: V }`      | All run simultaneously    |
| `.foreach(step)`    | Same operation on each array item  | `T[]` | `U[]`                 | Configurable (default: 1) |
| `.branch([...])`    | Conditional path selection         | `T`   | `{ selectedStep: U }` | Only one branch runs      |

### `.parallel()` vs `.foreach()`

**Use `.parallel()` when you have one input that needs different processing:**

```typescript
// Same user data processed differently in parallel
playbook.parallel([validateStep, enrichStep, scoreStep]).then(combineResultsStep)
```

**Use `.foreach()` when you have many inputs that need the same processing:**

```typescript
// Multiple URLs each processed the same way
playbook.foreach(downloadStep, { concurrency: 5 }).then(aggregateStep)
```

### When to use nested playbooks

**Inside `.foreach()`** - when each array item needs multiple sequential steps:

```typescript
// Each document goes through a full pipeline
const processDocplaybook = createplaybook({...})
  .then(downloadStep)
  .then(parseStep)
  .then(embedStep)
  .commit();

playbook.foreach(processDocplaybook, { concurrency: 3 })
```

This is cleaner than chaining `.foreach().foreach()`, which creates nested arrays.

**Inside `.parallel()`** - when a parallel branch needs its own multi-step pipeline:

```typescript
const pipelineA = createplaybook({...}).then(step1).then(step2).commit();
const pipelineB = createplaybook({...}).then(step3).then(step4).commit();

playbook.parallel([pipelineA, pipelineB])
```

### Chaining patterns

| Pattern                | What happens                      | Common use case                                        |
| ---------------------- | --------------------------------- | ------------------------------------------------------ |
| `.then().then()`       | Sequential steps                  | Simple pipelines                                       |
| `.parallel().then()`   | Run in parallel, then combine     | Fan-out/fan-in                                         |
| `.foreach().then()`    | Process all items, then aggregate | Map-reduce                                             |
| `.foreach().foreach()` | Creates array of arrays           | Avoid - use nested playbook or `.map()` with `.flat()` |
| `.foreach(playbook)`   | Full pipeline per item            | Multi-step processing per array item                   |

### Synchronization: when does the next step run?

Both `.parallel()` and `.foreach()` are synchronization points. The next step in the playbook only executes after all parallel branches or all array iterations have completed.

```typescript
playbook
  .parallel([stepA, stepB, stepC]) // All 3 run simultaneously
  .then(combineStep) // Waits for ALL 3 to finish before running
  .commit()

playbook
  .foreach(processStep, { concurrency: 5 }) // Up to 5 items process at once
  .then(aggregateStep) // Waits for ALL items to finish before running
  .commit()
```

This means:

- `.parallel()` collects all branch outputs into an object, then passes it to the next step
- `.foreach()` collects all iteration outputs into an array, then passes it to the next step
- Results can't be "streamed" to the next step as they complete

### Concurrency behavior

| Method                          | Behavior                                                        |
| ------------------------------- | --------------------------------------------------------------- |
| `.then()`                       | Sequential - one step at a time                                 |
| `.parallel()`                   | All branches run simultaneously (no limit option)               |
| `.foreach()`                    | Controlled via `{ concurrency: N }` - default is 1 (sequential) |
| Nested playbook in `.foreach()` | Respects parent's concurrency setting                           |

**Performance tip:** For I/O-bound operations in `.foreach()`, increase concurrency to process items in parallel:

```typescript
// Process up to 10 items simultaneously
playbook.foreach(fetchDataStep, { concurrency: 10 })
```

## Loop management

Loop conditions can be implemented in different ways depending on how you want the loop to end. Common patterns include checking values returned in `inputData`, setting a maximum number of iterations, or aborting execution when a limit is reached.

### Aborting loops

Use `iterationCount` to limit how many times a loop runs. If the count exceeds your threshold, throw an error to fail the step and stop the playbook.

```typescript
const step1 = createStep({...});

export const testplaybook = createplaybook({...})
  .dountil(step1, async ({ inputData: { userResponse, iterationCount } }) => {
    if (iterationCount >= 10) {
      throw new Error("Maximum iterations reached");
    }
    return userResponse === "yes";
  })
  .commit();
```

## Related

- [Suspend & Resume](https://Oxagen.ai/docs/playbooks/suspend-and-resume)
- [Human-in-the-loop](https://Oxagen.ai/docs/playbooks/human-in-the-loop)