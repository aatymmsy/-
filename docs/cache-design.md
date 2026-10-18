# Prompt cache design

Cache reuse depends on an exact prefix that the selected provider has already cached. A first request to a genuinely new prefix can have zero hits. Perch does not replace that measurement with a local estimate.

## What changed in 0.2

Previously, persona, recent diaries, memory and environment were combined in one message. Additional fixed style and memory instructions followed it. A changed reference early in that message prevented the later fixed content from sharing an exact prefix across sessions.

New snapshots use this order:

1. General instructions.
2. Stable style instructions.
3. Stable memory rules, including the instruction to omit memory tags from diary output.
4. Persona.
5. Runtime environment.
6. Diary reference.
7. Memory reference.
8. Conversation history and the current turn.

The tool definitions remain in a stable order. Session IDs and creation timestamps are not inserted into the prompt. References remain fixed for a session. Older sessions retain their previous layout and stored history.

Normal chat and diary requests share the fixed instructions, rather than removing a system message at diary time. Permission overrides remain explicit and can invalidate part of the cache. History compaction deliberately trades prefix reuse for a bounded request size; original records remain available through the history tool.

## Reproduce the structural checks

```sh
node --test tests/cache-prefix.test.mjs
```

The tests create a session, change diary/memory references, and create another session with the same persona. They check that the first five system messages are identical, that changed references are actually present, and that old snapshots are untouched. They also check that the first turn sends one request, a later normal turn retains the complete previous request prefix, diary generation retains it, and reported zero cache hits stay zero.

These are deterministic correctness tests. They do not predict a commercial service's tokenization, cache retention, routing, minimum prefix length, or resulting bill.

## Validate with your provider

Start a new session after upgrading. Keep the model, endpoint, persona and tools unchanged. Send a normal message, then another; compare the reported cached tokens and total input tokens. Repeat with a new session to assess cross-session prefix reuse. Account for provider cache expiration and changed references. Do not infer a guaranteed improvement from one pair of requests.

There are no hidden warmup calls or duplicated model requests intended to improve a displayed percentage. Unknown usage is excluded from cache ratio denominators, rather than counted as zero. Characters in context diagnostics are not token counts.

Primary references:

- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/) — automatic caching, prefix persistence, reported hit/miss tokens, best-effort behavior.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) — prefix reuse and model-specific cache behavior.

Provider-specific cache parameters are not automatically added to arbitrary compatible endpoints. Advanced parameters remain explicitly configurable by the user.
