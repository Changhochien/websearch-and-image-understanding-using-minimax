/**
 * MiniMax Web Search & Image Understanding Extension for pi
 * 
 * Features:
 * - Uses pi's internal MiniMax API key by default (ANTHROPIC_AUTH_TOKEN)
 * - Provides /set-minimax-key command to configure custom API key
 * - Stores user-configured key in ~/.config/minimax-support/creds.toml
 * - Registers search and understand tools
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
  
  // ── Tool: minimax_search ──────────────────────────────────────────────────
  
  pi.registerTool({
    name: "minimax_search",
    label: "MiniMax Search",
    description: "Search the web using MiniMax Token Plan API. Use for real-time web search, looking up information, or finding online resources.",
    promptSnippet: "MiniMax web search for current information",
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
        
        // Use curl to call the API directly
        const searchUrl = `${creds.apiHost}/v1/coding_plan/search`;
        const body = JSON.stringify({ q: params.query });
        
        const curlCmd = [
          "curl", "-s", "-X", "POST", searchUrl,
          "-H", `Authorization: Bearer ${creds.apiKey}`,
          "-H", "Content-Type: application/json",
          "-d", body,
          "--max-time", "30"
        ];
        
        const result = execSync(curlCmd.join(" "), { encoding: "utf-8" });
        const data = JSON.parse(result);
        
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
        const vlmUrl = `${creds.apiHost}/v1/coding_plan/vlm`;
        const body = JSON.stringify({ prompt: params.prompt, image_url: imageUrl });
        
        const curlCmd = [
          "curl", "-s", "-X", "POST", vlmUrl,
          "-H", `Authorization: Bearer ${creds.apiKey}`,
          "-H", "Content-Type: application/json",
          "-d", body,
          "--max-time", "60"
        ];
        
        const result = execSync(curlCmd.join(" "), { encoding: "utf-8" });
        const data = JSON.parse(result);
        
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
