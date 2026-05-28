/**
 * MiniMax Web Search, Web Fetch & Image Understanding Extension for pi
 * 
 * Features:
 * - Uses pi's internal MiniMax API key by default (ANTHROPIC_AUTH_TOKEN)
 * - Provides /set-minimax-key command to configure custom API key
 * - Stores user-configured key in ~/.config/minimax-support/creds.toml
 * - Registers search, fetch, and image understanding tools
 * - SSRF guard prevents access to private/loopback addresses
 * - Smart content negotiation: HEAD, sniff, sibling .md detection
 * - HTML → Markdown via Readability + Turndown + GFM
 * - Output modes: auto (inline ≤15K chars), inline, file
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import { URL } from "url";
import {
  FetchError,
  fetchWithNegotiation,
  validateUrl,
  htmlToMarkdown,
  wrapAsCodeBlock,
  writeTempFile,
} from "./fetch";

interface MinimaxCredentials {
  apiKey: string;
  apiHost: string;
}

// ─── Credentials Management ───────────────────────────────────────────────────

function getPiAuthPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

function getCredsPath(): string {
  return path.join(os.homedir(), ".config", "minimax-support", "creds.toml");
}

interface PiAuth {
  [provider: string]: {
    type: string;
    key?: string;
  };
}

function loadCredentials(): MinimaxCredentials | null {
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
  
  const piAuthPath = getPiAuthPath();
  if (fs.existsSync(piAuthPath)) {
    try {
      const authData: PiAuth = JSON.parse(fs.readFileSync(piAuthPath, "utf-8"));
      
      if (authData.minimax?.key) {
        return { apiKey: authData.minimax.key, apiHost: "https://api.minimax.io" };
      }
      if (authData["minimax-cn"]?.key) {
        return { apiKey: authData["minimax-cn"].key, apiHost: "https://api.minimaxi.com" };
      }
    } catch {
      // Ignore parse errors
    }
  }
  
  return null;
}

function saveCredentials(apiKey: string, apiHost?: string): void {
  const configDir = path.join(os.homedir(), ".config", "minimax-support");
  const credsPath = path.join(configDir, "creds.toml");
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  const hostLine = apiHost ? `\nMINIMAX_API_HOST="${apiHost}"` : "";
  fs.writeFileSync(credsPath, `MINIMAX_API_KEY="${apiKey}"${hostLine}\n`);
}

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

// ─── Constants ────────────────────────────────────────────────────────────────

const INLINE_MAX_CHARS = 15_000;
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);
const SKIP_CONTENT_TYPES = new Set([
  "image/", "video/", "audio/", "application/octet-stream",
]);

// ─── Extension Registration ───────────────────────────────────────────────────

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
        const isInternal = process.env.ANTHROPIC_AUTH_TOKEN === creds.apiKey;
        const source = isInternal ? "pi internal key" : "user-configured";
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
  
  // ── Command: /minimax-clear-key ──────────────────────────────────────────
  
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
  
  // ── Tool: web_search ─────────────────────────────────────────────────────
  
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
        
        const data = await httpsRequest<{
          organic?: Array<{ title: string; link: string; snippet?: string }>;
          related_searches?: Array<{ query: string }>;
        }>(
          `${creds.apiHost}/v1/coding_plan/search`,
          { q: params.query },
          creds.apiKey
        );
        
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
        
        if (params.related && data.related_searches && data.related_searches.length > 0) {
          response += "Related: " + data.related_searches.map((r) => r.query).join(", ");
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
  
  // ── Tool: web_fetch ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and read content from a URL. Automatically converts HTML to clean Markdown using Readability + Turndown with GitHub Flavored Markdown support. Smart content negotiation detects Markdown files, raw text, and HTML pages.",
    promptSnippet: "Fetch and read web page content",
    promptGuidelines: [
      "Use web_fetch to read the full content of a specific URL — documentation pages, blog posts, API references found via web_search.",
      "web_fetch complements web_search: search finds URLs, fetch reads them.",
      'After answering using fetched content, include a "Sources:" section with a markdown hyperlink to the URL.',
      "Large responses (>15K chars) are automatically saved to a temp file. Use the 'read' tool to access the full content.",
      "The tool automatically detects Markdown files, raw text, and HTML pages using content negotiation.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch. Must be http or https." }),
      output_mode: Type.Optional(
        Type.Union(
          [Type.Literal("auto"), Type.Literal("inline"), Type.Literal("file")],
          { description: "Output mode: auto (inline ≤15K chars, else file), inline (always return content), file (always write to temp file)", default: "auto" }
        )
      ),
      abs_links: Type.Optional(
        Type.Boolean({
          description: "Absolutize relative links and images in Markdown (default: true)",
          default: true
        })
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: "Fetch timeout in milliseconds (default: 30000)",
          default: 30000
        })
      ),
      raw: Type.Optional(
        Type.Boolean({
          description: "DEPRECATED: Use output_mode='file' instead. If true, return raw content instead of Markdown.",
          default: false
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      try {
        // Validate URL first
        const targetUrl = validateUrl(params.url);
        
        // Get options
        const raw = params.raw ?? false;
        const outputMode = (params.output_mode as "auto" | "inline" | "file" | undefined) ?? "auto";
        const absLinks = (params.abs_links as boolean | undefined) ?? true;
        const timeoutMs = typeof params.timeout_ms === "number" ? params.timeout_ms : 30000;

        // Handle deprecated raw parameter
        const finalOutputMode = raw ? "file" : outputMode;

        onUpdate?.({ content: [{ type: "text", text: `Fetching: ${params.url}...` }] });

        // Use smart content negotiation
        const result = await fetchWithNegotiation(targetUrl.toString(), { timeoutMs });

        // Resolve content to Markdown
        let markdown: string;
        if (result.isMarkdown) {
          markdown = result.text;
        } else if (result.isPlainText) {
          markdown = wrapAsCodeBlock(result.text, result.url);
        } else {
          markdown = await htmlToMarkdown(result.text, result.url, { absLinks });
        }

        const lines = markdown.split("\n").length;
        const chars = markdown.length;

        // Determine output mode
        const useFile = finalOutputMode === "file" || 
                       (finalOutputMode === "auto" && chars > INLINE_MAX_CHARS);

        const details: Record<string, unknown> = {
          url: result.url,
          contentType: result.contentType,
          isMarkdown: result.isMarkdown,
          isPlainText: result.isPlainText,
        };

        if (useFile) {
          const filePath = writeTempFile(markdown, "minimax-fetch", ".md");
          details.filePath = filePath;
          details.chars = chars;
          details.lines = lines;
          
          return {
            content: [
              {
                type: "text",
                text: `Content written to ${filePath} (${chars.toLocaleString()} chars, ${lines.toLocaleString()} lines). Use the read tool to access it.`,
              },
            ],
            details,
          };
        }

        // Inline output
        details.chars = chars;
        details.lines = lines;

        return {
          content: [{ type: "text", text: markdown }],
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
          
          const imageBuffer = fs.readFileSync(imagePath);
          const ext = path.extname(imagePath).toLowerCase();
          let mimeType = "image/jpeg";
          if (ext === ".png") mimeType = "image/png";
          else if (ext === ".webp") mimeType = "image/webp";
          
          const base64 = imageBuffer.toString("base64");
          imageUrl = `data:${mimeType};base64,${base64}`;
        }
        
        const data = await httpsRequest<{
          base_resp?: { status_code: number; status_msg?: string };
          content?: string;
        }>(
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
