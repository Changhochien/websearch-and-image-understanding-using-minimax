---
name: websearch-image-understanding
description: Web search, page fetching, and image understanding via MiniMax Token Plan APIs. Use when asked to "search the web", "look up", "find information online", "fetch a URL", "read a web page", "analyze an image", "describe this image", or "understand what's in this picture".
---

# websearch-image-understanding

Token-efficient web search, page fetching, and image understanding via MiniMax Token Plan APIs.

**Features:**
- Uses pi's built-in MiniMax authentication automatically (no setup required)
- Supports custom API key configuration via `/set-minimax-key` command
- Provides `minimax_search`, `minimax_fetch`, and `image_understanding` tools
- SSRF protection — blocks requests to private/loopback addresses
- Large responses are truncated and spilled to temp files for later reading

---

## Quick Start (No Setup!)

If you're using a pi with MiniMax integration, the API key is automatically configured.

Try it:
```
search "latest AI news"
describe this image: ./screenshot.png
```

---

## Commands

### `/set-minimax-key <api-key> [region]`

Configure your own MiniMax API key (overrides pi's built-in key).

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

### `minimax_search`

Search the web for real-time information.

```
minimax_search({
  query: "Python 3.13 release date",
  related: true  // optional: include related searches
})
```

### `image_understanding`

Analyze images (URLs, local files, or base64).

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

### `minimax_fetch`

Fetch and read content from any web page URL. Returns cleaned plain text (or raw HTML with `raw: true`).

```
minimax_fetch({
  url: "https://docs.python.org/3/whatsnew/3.13.html"
})

minimax_fetch({
  url: "https://example.com/api-docs",
  raw: true
})
```

**Features:**
- Strips HTML to readable text by default
- Extracts page title automatically
- Blocks private/loopback addresses (SSRF protection)
- Large pages (>500 lines or >80KB) are truncated with full content saved to a temp file

---

## When to Use

- User asks to "search for X", "look up", "find information online"
- User shares an image and asks what it contains
- User wants real-time web information
- User asks "what's in this screenshot/photo"

---

## Technical Details

**API Endpoints:**
- Global: `https://api.minimax.io`
- China: `https://api.minimaxi.com`

**Key Priority:**
1. User-configured key (`~/.config/minimax-support/creds.toml`)
2. Pi built-in "MiniMax" authentication (global)
3. Pi built-in "MiniMax (China)" authentication

The extension automatically handles authentication - no environment variables needed!
