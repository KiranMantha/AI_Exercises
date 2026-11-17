# legacy-migration-agents

A fully local multi-agent system that migrates a small CommonJS project to TypeScript.
Orchestration is plain JS; the LLM is served by LM Studio.

**Phase 1 (this state):** the LLM client and the websearch agent only.

## Setup

1. In LM Studio, load a model that supports tool use.
2. Open the **Developer** tab and start the local server (default `http://localhost:1234`).
3. Set the model identifier shown there:

   ```sh
   export LMSTUDIO_MODEL="your-model-id"
   ```

Node 20+ and pnpm. There are no dependencies (built-in `fetch` and `node:test`).

## Usage

```sh
pnpm ask "What is the latest stable Node.js LTS version?"   # step log on stderr, answer on stdout
pnpm test                                                   # no LM Studio or network needed
```

## Environment variables

| Variable | Default |
| --- | --- |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` |
| `LMSTUDIO_MODEL` | `YOUR_MODEL_ID` |

## `<think>` blocks

Reasoning models may emit `<think>...</think>` inside `message.content`. `src/llm.js`
strips them (including an unclosed trailing block) once, before the message is returned
and stored, so reasoning never leaks into the answer or the conversation history.

## Native tool calling vs. text-based tool parsing

With native tool calling the request carries a `tools` array of JSON schemas and the
server returns structured `message.tool_calls` (`id`, `function.name`, `function.arguments`
as a JSON string). We reply with `{ role: "tool", tool_call_id, content }`, and the server
applies the model's chat template. With text-based parsing the model is prompted to print
something like `Action: web_search("...")` and the program extracts it with regexes, which
is fragile (format drift, quoting, no call ids, parallel calls). This project uses only the
native path: if the model returns no `tool_calls`, the content is treated as the final answer.
