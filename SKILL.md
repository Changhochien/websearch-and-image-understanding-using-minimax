---
name: minimax-web-search
description: Web search via the MiniMax Token Plan API. Use when asked to search the web, look up current facts, or find information online.
---

# MiniMax Web Search

Token-efficient web search via the MiniMax Token Plan API.

**Features:**
- Uses pi's built-in MiniMax authentication automatically (no setup required)
- Supports custom API key configuration via `/set-minimax-key`
- Provides the `web_search` tool
- **No direct HTTP fetching** — for `web_fetch` / `batch_web_fetch` install `pi-smart-fetch`

---

## Quick Start (No Setup!)

If you're using pi with the MiniMax provider, the API key is automatically configured.

Try it:
```
search "latest AI news"
```

## Native Image Input

Models with image support accept images directly through pi, for example:

```bash
pi @screenshot.png "Describe this interface"
```

This package intentionally does not register a separate image-analysis tool, avoiding conflicts with pi's native multimodal input.

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

**Returns:** A bounded numbered list of up to 10 results with title, URL, optional date, and snippet. If `related: true`, a "Related: …" line is appended with up to 10 suggested follow-up queries. Requests time out after 30 seconds and honor Pi cancellation.

## When to Use

- User asks to "search for X", "look up", or "find information online"
- User wants real-time web information

For fetching the contents of a specific URL after searching, defer to `pi-smart-fetch`'s `web_fetch` tool.

---

## Technical Details

**API Endpoints:**
- Global: `https://api.minimax.io`
- China: `https://api.minimaxi.com`

**Key Priority:**
1. User-configured key (`~/.config/minimax-support/creds.toml`) — set via `/set-minimax-key`
2. Pi-resolved "MiniMax" authentication (global) — stored credentials or `MINIMAX_API_KEY`
3. Pi-resolved "MiniMax CN" authentication — stored credentials or `MINIMAX_CN_API_KEY`

Pi authentication is resolved through the Pi 0.83+ ModelRegistry API; the extension does not parse `auth.json` directly.

**Dependencies:** Runtime `typebox`, the Pi-provided `@earendil-works/pi-coding-agent` peer, and Node built-ins.

The extension automatically handles authentication — no environment variables needed!
