# Example LLM provider answers

Example answers written from the public API references of OpenAI's chat completions (`POST /v1/chat/completions`) and Anthropic's Messages API (`POST /v1/messages`, `anthropic-version: 2023-06-01`), checked on 2026-09-26. They are not recordings of live answers (plan 3B ruling LL11); the opt-in live check (`pnpm llm:live`) compares the OpenAI shape with a local Ollama's `/v1`. Model names and ids are invented.

`anthropic-message-thinking.json` is the answer of a current Claude model that thinks, written from the extended thinking documentation and checked on 2026-10-25: a `thinking` block whose text is empty (the default display) with its `signature`, a `redacted_thinking` block with its `data`, then the `text`. The signature and the data are made-up base64, not any model's. The blocks must go back to the API unchanged, in the order they came, on every later turn of a conversation.
