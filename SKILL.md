---
name: websearch-image-understanding
description: Web search and image understanding via MiniMax Token Plan APIs. Use when asked to "search the web", "look up", "find information online", "analyze an image", "describe this image", or "understand what's in this picture".
---

# websearch-image-understanding

Token-efficient web search and image understanding via MiniMax Token Plan APIs.

**Features:**
- Uses pi's built-in MiniMax authentication automatically (no setup required)
- Supports custom API key configuration via `/set-minimax-key` command
- Provides `web_search` and `image_understanding` tools
- **No direct HTTP fetching** — for `web_fetch` / `batch_web_fetch` install `pi-smart-fetch`

---

## Quick Start (No Setup!)

If you're using pi with the MiniMax provider, the API key is automatically configured.

Try it:
```
search "latest AI news"
describe this image: ./screenshot.png
```

---

## Related package: `pi-smart-fetch`

This extension deliberately does **not** ship a `web_fetch` tool. For page fetching — including bot-resistant fetching of Cloudflare-protected sites, site-specific extractors (YouTube, Reddit, X, GitHub, HN, Substack), and `batch_web_fetch` with per-item progress — install:

```bash
pi install npm:pi-smart-fetch
```

`pi-smart-fetch` uses `wreq-js` for browser-impersonated TLS and `defuddle` for content extraction, and is independently maintained at [Thinkscape/agent-smart-fetch](https://github.com/Thinkscape/agent-smart-fetch). The two packages compose cleanly: use `web_search` here to find URLs, then `web_fetch` from `pi-smart-fetch` to read them.

---

## Commands

### `/set-minimax-key <api-key> [region]`

Configure your own MiniMax API key (overrides the built-in key).

```bash
# Global endpoint (default)
/set-minimax-key sk-xxxxxxxxxxxxxx

# China endpoint
/set-minimax-key sk-xxxxxxxxxxxxxx cn
```

Get your key from: https://platform.minimax.io/subscribe/token-plan

### `/minimax-status`

Check which API key is currently in use.

### `/minimax-clear-key`

Clear your custom key and revert to pi's built-in key.

---

## Tools

### `web_search`

Search the web for real-time information.

```
web_search({
  query: "Python 3.13 release date",
  related: true  // optional: include related searches
})
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | ✓ | The search query |
| `related` | boolean | `false` | Include related searches in the response |

**Returns:** A numbered list of results with title, URL, and snippet. If `related: true`, a "Related: …" line is appended with suggested follow-up queries.

### `image_understanding`

Analyze an image (URL, local file, or base64 data) and get an AI description.

```
image_understanding({
  image: "https://example.com/photo.jpg",
  prompt: "What does this image show?"
})

image_understanding({
  image: "./screenshot.png",
  prompt: "Describe the UI elements"
})
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `image` | string | Image URL, local file path, or base64 data. The `@` prefix (MCP convention) is stripped automatically. |
| `prompt` | string | Question or instruction about the image |

**Local file support:** If `image` is not an `http://`, `https://`, or `data:` URL, it is treated as a path. Absolute paths are used as-is; relative paths resolve against the current working directory. Supported formats: JPEG, PNG, WebP (other formats are detected by extension and sent with the best-guess mime type).

---

## When to Use

- User asks to "search for X", "look up", "find information online"
- User shares an image and asks what it contains
- User wants real-time web information
- User asks "what's in this screenshot/photo"

For fetching the contents of a specific URL after searching, defer to `pi-smart-fetch`'s `web_fetch` tool.

---

## Technical Details

**API Endpoints:**
- Global: `https://api.minimax.io`
- China: `https://api.minimaxi.com`

**Key Priority:**
1. User-configured key (`~/.config/minimax-support/creds.toml`) — set via `/set-minimax-key`
2. Pi built-in "MiniMax" authentication (global) — from `~/.pi/agent/auth.json`
3. Pi built-in "MiniMax (China)" authentication — from `~/.pi/agent/auth.json`

**Dependencies:** None at runtime. The extension is pure Node built-ins (`fs`, `path`, `os`, `https`, `url`).

The extension automatically handles authentication — no environment variables needed!
