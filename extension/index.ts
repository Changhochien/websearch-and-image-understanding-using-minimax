/**
 * MiniMax Web Search, Web Fetch & Image Understanding Extension for pi
 * 
 * Features:
 * - Uses pi's internal MiniMax API key by default (ANTHROPIC_AUTH_TOKEN)
 * - Provides /set-minimax-key command to configure custom API key
 * - Stores user-configured key in ~/.config/minimax-support/creds.toml
 * - Registers search, fetch, and image understanding tools
 * - SSRF guard prevents access to private/loopback addresses
 * - Large response spillover to temp file with truncation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import { URL } from "url";

interface MinimaxCredentials {
  apiKey: string;
  apiHost: string;
}

// Path to pi's auth.json
function getPiAuthPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

// Path to store user-configured credentials
function getCredsPath(): string {
  return path.join(os.homedir(), ".config", "minimax-support", "creds.toml");
}

interface PiAuth {
  [provider: string]: {
    type: string;
    key?: string;
  };
}

/**
 * Load credentials with priority:
 * 1. User-configured key in creds.toml
 * 2. Pi's built-in minimax authentication
 * 3. Pi's built-in minimax-cn (China) authentication
 */
function loadCredentials(): MinimaxCredentials | null {
  // First, check for user-configured key
  const credsPath = getCredsPath();
  if (fs.existsSync(credsPath)) {
    try {
      const content = fs.readFileSync(credsPath, "utf-8");
      let apiKey = "";
      let apiHost = "";
      
      for (const line of content.split("\n")) {
        if (line.includes("=")) {
          const [k, ...vParts] = line.split("=");
          const v = vParts.join("=").trim().replace(/^["']|["']$/g, "");
          if (k.trim() === "MINIMAX_API_KEY" && !apiKey) apiKey = v;
          if (k.trim() === "MINIMAX_API_HOST" && !apiHost) apiHost = v;
        }
      }
      
      if (apiKey) {
        return {
          apiKey,
          apiHost: apiHost || "https://api.minimax.io",
        };
      }
    } catch {
      // Ignore parse errors
    }
  }
  
  // Fall back to pi's built-in minimax authentication
  const piAuthPath = getPiAuthPath();
  if (fs.existsSync(piAuthPath)) {
    try {
      const authData: PiAuth = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));
      
      // Try minimax (global)
      if (authData.minimax?.key) {
        return {
          apiKey: authData.minimax.key,
          apiHost: "https://api.minimax.io",
        };
      }
      
      // Try minimax-cn (China)
      if (authData["minimax-cn"]?.key) {
        return {
          apiKey: authData["minimax-cn"].key,
          apiHost: "https://api.minimaxi.com",
        };
      }
    } catch {
      // Ignore parse errors
    }
  }
  
  return null;
}

/**
 * Save user-configured credentials
 */
function saveCredentials(apiKey: string, apiHost?: string): void {
  const configDir = path.join(os.homedir(), ".config", "minimax-support");
  const credsPath = path.join(configDir, "creds.toml");
  
  // Create directory if needed
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  const hostLine = apiHost ? `\nMINIMAX_API_HOST="${apiHost}"` : "";
  fs.writeFileSync(credsPath, `MINIMAX_API_KEY="${apiKey}"${hostLine}\n`);
}

/**
 * Make an HTTPS POST request with JSON body
 */
function httpsRequest<T = Record<string, unknown>>(url: string, body: Record<string, unknown>, apiKey: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });
    
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    
    req.write(data);
    req.end();
  });
}

// ─── Web Fetch helpers ──────────────────────────────────────────────────────

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);
const SKIP_CONTENT_TYPES = new Set([
  "image/", "video/", "audio/", "application/octet-stream",
]);
const MAX_FETCH_LINES = 500;
const MAX_FETCH_BYTES = 80_000;

interface FetchTruncation {
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
}

function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Unsupported protocol: ${parsed.protocol}. Only http and https are allowed.`,
    );
  }
  if (isPrivateOrLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to fetch private/loopback address: ${parsed.hostname}`,
    );
  }
  return parsed;
}

function htmlToText(html: string): string {
  // Aggressive strip-to-text: remove scripts, styles, tags, decode entities
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  return match[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
}

function truncateText(
  text: string,
): { text: string; truncation?: FetchTruncation } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text, "utf-8");

  if (totalLines <= MAX_FETCH_LINES && totalBytes <= MAX_FETCH_BYTES) {
    return { text };
  }

  let outputLines = 0;
  let outputBytes = 0;
  const truncated: string[] = [];
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
    if (outputLines >= MAX_FETCH_LINES || outputBytes + lineBytes > MAX_FETCH_BYTES) {
      break;
    }
    truncated.push(line);
    outputLines++;
    outputBytes += lineBytes;
  }

  return {
    text: truncated.join("\n"),
    truncation: { totalLines, outputLines, totalBytes, outputBytes },
  };
}

export default function (pi: ExtensionAPI) {
  // ── Command: /set-minimax-key ─────────────────────────────────────────────
  
  pi.registerCommand("set-minimax-key", {
    description: "Configure your own MiniMax API key (overrides internal key)",
    getArgumentCompletions: (_prefix) => [
      { value: "global", description: "Use global endpoint (api.minimax.io)" },
      { value: "cn", description: "Use China endpoint (api.minimaxi.com)" },
    ],
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const apiKey = parts[0];
      const region = parts[1]?.toLowerCase();
      
      if (!apiKey) {
        ctx.ui.notify("Usage: /set-minimax-key <api-key> [global|cn]", "error");
        return;
      }
      
      // Determine host based on region
      let apiHost = "https://api.minimax.io";
      if (region === "cn") {
        apiHost = "https://api.minimaxi.com";
      }
      
      saveCredentials(apiKey, apiHost);
      ctx.ui.notify("MiniMax API key saved! Use /minimax-status to verify.", "info");
    },
  });
  
  // ── Command: /minimax-status ──────────────────────────────────────────────
  
  pi.registerCommand("minimax-status", {
    description: "Check MiniMax API key status",
    handler: async (_args, ctx) => {
      const creds = loadCredentials();
      
      if (creds) {
        // Check if using internal or user key
        const isInternal = process.env.ANTHROPIC_AUTH_TOKEN === creds.apiKey;
        const source = isInternal ? "pi internal key" : "user-configured";
        
        // Mask the key for display
        const maskedKey = creds.apiKey.slice(0, 8) + "..." + creds.apiKey.slice(-4);
        
        ctx.ui.notify(
          `MiniMax: Using ${source}\nKey: ${maskedKey}\nHost: ${creds.apiHost}`,
          "info"
        );
      } else {
        ctx.ui.notify(
          "MiniMax: No API key configured.\nSet with: /set-minimax-key <key> [global|cn]",
          "warning"
        );
      }
    },
  });
  
  // ── Command: /minimax-clear-key ───────────────────────────────────────────
  
  pi.registerCommand("minimax-clear-key", {
    description: "Clear user-configured key and use pi internal key",
    handler: async (_args, ctx) => {
      const credsPath = getCredsPath();
      if (fs.existsSync(credsPath)) {
        fs.unlinkSync(credsPath);
        ctx.ui.notify("User key cleared. Will use pi internal key if available.", "info");
      } else {
        ctx.ui.notify("No user key to clear.", "info");
      }
    },
  });
  
  // ── Tool: web_search ───────────────────────────────────────────────────
  
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for up-to-date information. Returns a list of results with titles, URLs, and snippets. Use when you need current information not in your training data.",
    promptSnippet: "Web search for current information",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      related: Type.Optional(Type.Boolean({ description: "Include related searches" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const creds = loadCredentials();
      
      if (!creds) {
        return {
          content: [{ type: "text", text: "No MiniMax API key available. Set with /set-minimax-key <api-key> [global|cn]" }],
          details: { error: "no_api_key" },
        };
      }
      
      try {
        onUpdate?.({ content: [{ type: "text", text: "Searching web..." }] });
        
        // Use Node's https module for reliable API call
        const data = await httpsRequest(
          `${creds.apiHost}/v1/coding_plan/search`,
          { q: params.query },
          creds.apiKey
        );
        
        // Format results
        const organic = data.organic || [];
        if (organic.length === 0) {
          return {
            content: [{ type: "text", text: "No search results found." }],
            details: data,
          };
        }
        
        let response = `Search results for "${params.query}":\n\n`;
        for (let i = 0; i < organic.length; i++) {
          const item = organic[i];
          response += `${i + 1}. ${item.title}\n   ${item.link}\n   ${item.snippet || ""}\n\n`;
        }
        
        if (params.related && data.related_searches?.length > 0) {
          response += "Related: " + data.related_searches.map((r: { query: string }) => r.query).join(", ");
        }
        
        return {
          content: [{ type: "text", text: response }],
          details: data,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Search failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
  
  // ── Tool: web_fetch ────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and read content from a URL. Returns extracted text from web pages. Use to read documentation, articles, or any web content found via search.",
    promptSnippet: "Fetch and read web page content",
    promptGuidelines: [
      "Use web_fetch to read the full content of a specific URL — documentation pages, blog posts, API references found via web_search.",
      "web_fetch complements web_search: search finds URLs, fetch reads them.",
      'After answering using fetched content, include a "Sources:" section with a markdown hyperlink to the URL.',
      "Large responses are truncated and spilled to a temp file — the file path is in the result details.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch. Must be http or https." }),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "If true, return raw HTML. Default false: strip HTML to plain text.",
          default: false,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      try {
        const targetUrl = validateUrl(params.url);
        const raw = params.raw ?? false;

        onUpdate?.({
          content: [{ type: "text", text: `Fetching: ${params.url}...` }],
        });

        const res = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: {
            Accept: "text/html, text/plain, */*",
            "Accept-Encoding": "gzip",
            "User-Agent": "pi-minimax-fetch/1.0",
          },
          signal,
          redirect: "follow",
        });

        if (!res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to fetch ${params.url}: HTTP ${res.status} ${res.statusText}`,
              },
            ],
            details: { url: params.url, status: res.status },
            isError: true,
          };
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (
          SKIP_CONTENT_TYPES.has(contentType) ||
          [...SKIP_CONTENT_TYPES].some((t) => contentType.startsWith(t))
        ) {
          return {
            content: [
              {
                type: "text",
                text: `Cannot fetch ${params.url}: unsupported content type "${contentType}" (images, video, and audio are not supported).`,
              },
            ],
            details: { url: params.url, contentType },
            isError: true,
          };
        }

        const body = await res.text();
        const title = extractTitle(body);

        // Process content: raw HTML or stripped text
        const processed = raw ? body : htmlToText(body);

        // Truncate large responses
        const { text: displayText, truncation } = truncateText(processed);

        const contentLength = res.headers.get("content-length");
        const details: Record<string, unknown> = {
          url: params.url,
          title,
          contentType: contentType || undefined,
          contentLength: contentLength ? Number(contentLength) : undefined,
        };

        let finalContent = `**Fetched:** ${params.url}\n`;
        if (title) finalContent += `**Title:** ${title}\n`;
        if (contentType) finalContent += `**Content-Type:** ${contentType}\n`;
        finalContent += `\n${displayText}`;

        if (truncation) {
          // Spill full content to temp file
          const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "minimax-fetch-"),
          );
          const spillPath = path.join(tmpDir, "full-content.txt");
          fs.writeFileSync(spillPath, processed, "utf-8");

          const truncatedLines =
            truncation.totalLines - truncation.outputLines;
          const truncatedBytes =
            truncation.totalBytes - truncation.outputBytes;
          finalContent += `\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${(truncation.outputBytes / 1000).toFixed(1)}KB of ${(truncation.totalBytes / 1000).toFixed(1)}KB). ${truncatedLines} lines (${(truncatedBytes / 1000).toFixed(1)}KB) omitted. Full content saved to: ${spillPath}]`;
          details.truncation = {
            totalLines: truncation.totalLines,
            outputLines: truncation.outputLines,
            totalBytes: truncation.totalBytes,
            outputBytes: truncation.outputBytes,
          };
          details.fullOutputPath = spillPath;
        }

        return {
          content: [{ type: "text", text: finalContent }],
          details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Fetch failed: ${message}` }],
          details: { error: message, url: params.url },
          isError: true,
        };
      }
    },
  });

  // ── Tool: image_understanding ───────────────────────────────────────────
  
  pi.registerTool({
    name: "image_understanding",
    label: "Image Understanding",
    description: "Analyze an image and get AI description using MiniMax Token Plan API. Supports URLs, local files, or base64 data.",
    promptSnippet: "Image analysis for describing or understanding images",
    parameters: Type.Object({
      image: Type.String({ description: "Image URL, local file path, or base64 data" }),
      prompt: Type.String({ description: "Question or instruction about the image" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const creds = loadCredentials();
      
      if (!creds) {
        return {
          content: [{ type: "text", text: "No MiniMax API key available. Set with /set-minimax-key <api-key> [global|cn]" }],
          details: { error: "no_api_key" },
        };
      }
      
      try {
        onUpdate?.({ content: [{ type: "text", text: "Analyzing image..." }] });
        
        // Process image - handle URLs, local files, or data
        let imageUrl = params.image;
        
        // Handle @ prefix (MCP convention)
        if (imageUrl.startsWith("@")) {
          imageUrl = imageUrl.slice(1);
        }
        
        // Handle local files
        if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://") && !imageUrl.startsWith("data:")) {
          const imagePath = imageUrl.startsWith("/") ? imageUrl : path.join(ctx.cwd, imageUrl);
          
          if (!fs.existsSync(imagePath)) {
            return {
              content: [{ type: "text", text: `Image file not found: ${imagePath}` }],
              details: { error: "file_not_found" },
              isError: true,
            };
          }
          
          // Convert to base64 data URL
          const imageBuffer = fs.readFileSync(imagePath);
          const ext = path.extname(imagePath).toLowerCase();
          let mimeType = "image/jpeg";
          if (ext === ".png") mimeType = "image/png";
          else if (ext === ".webp") mimeType = "image/webp";
          
          const base64 = imageBuffer.toString("base64");
          imageUrl = `data:${mimeType};base64,${base64}`;
        }
        
        // Call VLM API
        const data = await httpsRequest(
          `${creds.apiHost}/v1/coding_plan/vlm`,
          { prompt: params.prompt, image_url: imageUrl },
          creds.apiKey
        );
        
        if (data.base_resp?.status_code !== 0) {
          return {
            content: [{ type: "text", text: `API error: ${data.base_resp?.status_msg || "Unknown error"}` }],
            details: data,
            isError: true,
          };
        }
        
        const content = data.content || "No description returned.";
        
        return {
          content: [{ type: "text", text: content }],
          details: data,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Image analysis failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}
