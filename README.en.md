# Perch · 栖

**A desktop AI with character, memory, and the ability to get things done.**

[中文](README.md) · [CI](https://github.com/aatymmsy/-/actions/workflows/ci.yml) · [Issues](https://github.com/aatymmsy/-/issues)

![Perch](docs/assets/banner.svg)

Perch is a quiet home for your AI conversations and everyday work. Define a persona, keep meaningful memories, write a diary at the end of a conversation, and work with local files through explicit tool permissions.

Your model. Your records. Your choice of what the agent may do.

![Desktop application](docs/assets/desktop.png)

*Actual application, isolated demonstration data and mock responses. No personal conversations or commercial-model benchmark results are shown.*

## Start in three commands

Install [Node.js 24+](https://nodejs.org/), then:

```sh
git clone https://github.com/aatymmsy/-.git perch
cd perch
npm start
```

Open **http://127.0.0.1:39781**, configure a Chat Completions compatible endpoint and your own API key, choose a model, then start a conversation. No `npm install` is needed to run the app. The interface is currently Chinese.

On Windows, `启动.cmd` opens an Edge app window; `停止.cmd` shuts down the local service. Closing the window alone does not stop running tasks. The browser UI and server also run on Linux; the native launcher is Windows-only.

Try `npm run demo` at **http://127.0.0.1:39871** for a temporary, key-free demo with fixed mock responses.

## What you get

- **Conversation starters:** let the character speak first without losing your draft or attached images.
- **Continuity:** persona snapshots, short memories, full conversation history, and optional diaries.
- **Useful tools:** text files, directories, local images, and shell commands with visible results.
- **Control:** ask before actions by default, workspace-only mode, or full access.
- **Honest usage:** provider-reported input, output, and cache statistics; unknown stays unknown.
- **Recovery:** stop, retry, and continue truncated output without duplicating the user turn.

Preset connection options include OpenAI, DeepSeek, Kimi, SiliconFlow, Alibaba Cloud, Ollama, LM Studio, and custom endpoints. Tool use and vision depend on the selected model. Native Responses and Anthropic protocols are not implemented.

## Cache-friendly by construction

Version 0.2 orders stable instructions, persona and environment before changing diary and memory references. New sessions with the same persona can reuse a longer exact prefix; diary generation retains the stable instructions. Existing sessions keep their snapshots. Start a new session to use the new layout.

A cold prefix still needs a provider-side cache write. There are no synthetic warmup calls, padding, invented hit rates, or guaranteed first-turn savings. [Cache design and tests](docs/cache-design.md) explain the boundaries.

## Local storage, explicit network use

Records and configuration live in `data/`. There is no built-in account service or telemetry. Cloud model requests send the relevant context and supplied images to your configured provider. A compatible local model can keep inference on your computer.

API keys are currently stored in plaintext local configuration, excluded from space exports. Keep `data/` private. The management server binds to localhost and checks Host, Origin and a page token. Tool permissions are application policy, not an OS sandbox. Text overwrites are backed up; arbitrary shell operations may be irreversible.

Optional environment variables: `PERCH_DATA`, `PERCH_PORT`, and `PERCH_API_KEY`. Stop the server before backing up the whole data directory.

## Development

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:ui
```

CI covers Windows/Linux backend tests, syntax and release checks, Chromium interaction tests, and Windows launcher compilation. Tests use temporary data and mock models. No API keys or paid requests are required.

The application has zero runtime npm dependencies. Playwright is development-only. `npm run build:windows` creates a portable Windows ZIP; Node.js 24+ is still required.

See [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [changes](CHANGELOG.md). If Perch is useful to you, a star, a reproducible bug report, or sharing a real workflow helps the project grow.

Licensed under the repository's existing [MPL-2.0](LICENSE).
