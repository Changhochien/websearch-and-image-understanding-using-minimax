---
name: websearch-image-understanding
description: Web search, page fetching, and image understanding via MiniMax Token Plan APIs. Use when asked to "search the web", "look up", "find information online", "fetch a URL", "read a web page", "analyze an image", "describe this image", or "understand what's in this picture".
---

# websearch-image-understanding

Token-efficient web search, page fetching, and image understanding via MiniMax Token Plan APIs.

**Features:**
- Uses pi's built-in MiniMax authentication automatically (no setup required)
- Supports custom API key configuration via `/set-minimax-key` command
- Provides `web_search`, `web_fetch`, and `image_understanding` tools
- SSRF protection — blocks requests to private/loopback addresses
- **Smart content negotiation** — detects Markdown, plain text, and HTML
- **HTML → Markdown** conversion via Readability + Turndown + GFM
- **Output modes** — auto (inline ≤15K chars), inline, or file
- Large responses are automatically saved to temp files for later reading

---

## Quick Start (No Setup!)

If you're using a pi with MiniMax integration, the API key is automatically configured.

Try it:
```
search "latest AI news"
fetch https://docs.python.org/3/whatsnew/3.13.html
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

### `web_search`

Search the web for real-time information.

```
web_search({
  query: "Python 3.13 release date",
  related: true  // optional: include related searches
})
```

### `web_fetch`

Fetch and read content from any web page URL. Automatically converts HTML to clean Markdown.

```
web_fetch({
  url: "https://docs.python.org/3/whatsnew/3.13.html"
})

// With all options
web_fetch({
  url: "https://example.com/api-docs",
  output_mode: "auto",    // auto | inline | file
  abs_links: true,        // absolutize relative links
  timeout_ms: 30000       // request timeout
})
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | ✓ | HTTP(S) URL to fetch |
| `output_mode` | `"auto"` \| `"inline"` \| `"file"` | `"auto"` | Output mode |
| `abs_links` | boolean | `true` | Absolutize relative links |
| `timeout_ms` | number | `30000` | Timeout in milliseconds |

**Output Modes:**
- **`auto`** — returns Markdown inline if ≤15,000 characters; otherwise writes to a temporary file
- **`inline`** — always returns Markdown inline
- **`file`** — always writes to a temporary file

**Features:**
- Smart content negotiation (HEAD, sniff, sibling .md detection)
- Mozilla Readability for article extraction
- Turndown with GitHub Flavored Markdown (GFM) support
- Tables, strikethrough, and task lists preserved
- Code blocks with language detection
- Blocks dangerous URI schemes (javascript:, data:, file:)
- SSRF protection — refuses private/loopback addresses

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

---

## When to Use

- User asks to "search for X", "look up", "find information online"
- User shares an image and asks what it contains
- User wants real-time web information
- User asks "what's in this screenshot/photo"
- User provides a URL to read or research

---

## Technical Details

**API Endpoints:**
- Global: `https://api.minimax.io`
- China: `https://api.minimaxi.com`

**Key Priority:**
1. User-configured key (`~/.config/minimax-support/creds.toml`)
2. Pi built-in "MiniMax" authentication (global)
3. Pi built-in "MiniMax (China)" authentication

**Dependencies:**
- `@mozilla/readability` — Article content extraction
- `jsdom` — HTML DOM parsing
- `turndown` — HTML → Markdown conversion
- `turndown-plugin-gfm` — GitHub Flavored Markdown support

The extension automatically handles authentication - no environment variables needed!
