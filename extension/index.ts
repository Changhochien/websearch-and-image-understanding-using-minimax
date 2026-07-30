/**
 * MiniMax Web Search Extension for pi
 *
 * Registers the web_search tool, routed through the MiniMax Token Plan API.
 * Image analysis is intentionally left to pi's native multimodal model input.
 *
 * Authentication: uses pi's built-in MiniMax key by default, or a user-supplied
 * key configured via /set-minimax-key. Keys are loaded with this priority:
 *   1. ~/.config/minimax-support/creds.toml  (user-configured, /set-minimax-key)
 *   2. Pi ModelRegistry                      (stored/env MiniMax / MiniMax-CN auth)
 *
 * For web_fetch / batch_web_fetch (browser-fingerprinted HTTP + Defuddle
 * extraction + batching), install the separate `pi-smart-fetch` package:
 *   pi install npm:pi-smart-fetch
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GLOBAL_API_HOST = "https://api.minimax.io";
const CN_API_HOST = "https://api.minimaxi.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 30_000;
const MAX_ERROR_BYTES = 500;
const MAX_RESULTS = 10;
const MAX_RELATED_SEARCHES = 10;

type CredentialContext = Pick<ExtensionContext, "modelRegistry">;
type CredentialRegion = "global" | "cn";

export interface MinimaxCredentials {
  apiKey: string;
  apiHost: string;
  region: CredentialRegion;
  source: string;
}

export interface JsonResponse<T> {
  data: T;
  traceId?: string;
}

export interface NormalizedSearchResult {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
}

export interface NormalizedSearchResponse {
  organic: NormalizedSearchResult[];
  related_searches: Array<{ query: string }>;
  base_resp: { status_code: 0; status_msg?: string };
  trace_id?: string;
  truncated: boolean;
}

type CredentialResolver = (ctx: CredentialContext) => Promise<MinimaxCredentials | null>;
type JsonRequester = <T>(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
) => Promise<JsonResponse<T>>;

interface ExtensionDependencies {
  resolveCredentials: CredentialResolver;
  postJson: JsonRequester;
}

// ─── Credentials Management ───────────────────────────────────────────────────

function getCredsPath(): string {
  return path.join(os.homedir(), ".config", "minimax-support", "creds.toml");
}

function secureCredentialsDirectory(configDir: string, create: boolean): void {
  if (!fs.existsSync(configDir)) {
    if (!create) return;
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  const stats = fs.lstatSync(configDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("MiniMax credentials directory must be a real directory, not a symlink.");
  }
  fs.chmodSync(configDir, 0o700);
}

function secureCredentialsFile(credsPath: string): void {
  const stats = fs.lstatSync(credsPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("MiniMax credentials file must be a regular file, not a symlink.");
  }
  fs.chmodSync(credsPath, 0o600);
}

function parseConfigValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      throw new Error("Invalid quoted value in MiniMax credentials file.");
    }
  }
  return value.replace(/^['"]|['"]$/g, "");
}

export function normalizeApiHost(value: string): { apiHost: string; region: CredentialRegion } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MiniMax API host must be a valid URL.");
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("MiniMax API host must be an HTTPS URL without credentials.");
  }

  if (parsed.hostname === "api.minimax.io") {
    return { apiHost: GLOBAL_API_HOST, region: "global" };
  }
  if (parsed.hostname === "api.minimaxi.com") {
    return { apiHost: CN_API_HOST, region: "cn" };
  }
  throw new Error("MiniMax API host must be api.minimax.io or api.minimaxi.com.");
}

export function loadCustomCredentials(): MinimaxCredentials | null {
  const credsPath = getCredsPath();
  if (!fs.existsSync(credsPath)) return null;

  secureCredentialsDirectory(path.dirname(credsPath), false);
  secureCredentialsFile(credsPath);
  const content = fs.readFileSync(credsPath, "utf-8");
  let apiKey = "";
  let apiHost = GLOBAL_API_HOST;

  for (const line of content.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = parseConfigValue(line.slice(separator + 1));
    if (key === "MINIMAX_API_KEY" && !apiKey) apiKey = value.trim();
    if (key === "MINIMAX_API_HOST") apiHost = value.trim();
  }

  if (!apiKey) return null;
  const normalized = normalizeApiHost(apiHost);
  return { ...normalized, apiKey, source: "custom MiniMax credentials file" };
}

export async function resolvePiCredentials(ctx: CredentialContext): Promise<MinimaxCredentials | null> {
  // Pi 0.83+: use ModelRegistry so stored credentials, env values, and provider
  // overrides follow Pi's versioned auth resolution instead of parsing auth.json.
  for (const candidate of [
    { provider: "minimax", apiHost: GLOBAL_API_HOST, region: "global" as const },
    { provider: "minimax-cn", apiHost: CN_API_HOST, region: "cn" as const },
  ]) {
    const resolved = await ctx.modelRegistry.getProviderAuth(candidate.provider);
    const apiKey = resolved?.auth.apiKey?.trim();
    if (apiKey) {
      return {
        apiKey,
        apiHost: candidate.apiHost,
        region: candidate.region,
        source: resolved.source || `Pi ${candidate.provider} credentials`,
      };
    }
  }
  return null;
}

export async function resolveCredentials(ctx: CredentialContext): Promise<MinimaxCredentials | null> {
  return loadCustomCredentials() ?? resolvePiCredentials(ctx);
}

export function saveCredentials(apiKey: string, apiHost: string): void {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) throw new Error("MiniMax API key cannot be empty.");
  const normalized = normalizeApiHost(apiHost);
  const credsPath = getCredsPath();
  const configDir = path.dirname(credsPath);
  const tempPath = path.join(configDir, `.creds.${process.pid}.${randomUUID()}.tmp`);

  secureCredentialsDirectory(configDir, true);
  if (fs.existsSync(credsPath)) secureCredentialsFile(credsPath);
  try {
    fs.writeFileSync(
      tempPath,
      `MINIMAX_API_KEY=${JSON.stringify(trimmedKey)}\nMINIMAX_API_HOST=${JSON.stringify(normalized.apiHost)}\n`,
      { encoding: "utf-8", mode: 0o600, flag: "wx" },
    );
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, credsPath);
    fs.chmodSync(credsPath, 0o600);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function truncateUtf8(value: string, maxBytes: number, suffix = "…"): string {
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf-8");
  const buffer = Buffer.from(value, "utf-8");
  return buffer.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString("utf-8").replace(/\uFFFD+$/g, "") + suffix;
}

function redactCredential(value: string, apiKey: string): string {
  return apiKey ? value.replaceAll(apiKey, "[REDACTED]") : value;
}

function sanitizedHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return sanitized ? truncateUtf8(sanitized, 128) : undefined;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`MiniMax response exceeded ${maxBytes} bytes.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`MiniMax response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf-8");
}

export async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
  options: { timeoutMs?: number; maxResponseBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<JsonResponse<T>> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    const traceId = sanitizedHeader(response.headers.get("trace-id") || response.headers.get("x-trace-id"));
    const responseText = await readBoundedBody(response, options.maxResponseBytes ?? MAX_RESPONSE_BYTES);

    if (!response.ok) {
      const snippet = truncateUtf8(redactCredential(responseText, apiKey).trim(), MAX_ERROR_BYTES);
      const trace = traceId ? ` Trace-Id: ${traceId}.` : "";
      throw new Error(`MiniMax HTTP ${response.status}${snippet ? `: ${snippet}` : "."}${trace}`);
    }

    try {
      return { data: JSON.parse(responseText) as T, traceId };
    } catch {
      const snippet = truncateUtf8(redactCredential(responseText, apiKey).trim(), MAX_ERROR_BYTES);
      throw new Error(`MiniMax returned invalid JSON${snippet ? `: ${snippet}` : "."}`);
    }
  } catch (error) {
    if (signal?.aborted) throw new Error("MiniMax search was cancelled.");
    if (timeoutSignal.aborted) throw new Error("MiniMax search request timed out.");
    throw error;
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function httpUrl(value: unknown): string | undefined {
  const candidate = boundedString(value, 2_048);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeSearchResponse(raw: unknown, traceId?: string): NormalizedSearchResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("MiniMax returned an unexpected search response.");
  }
  const record = raw as Record<string, unknown>;
  const baseResp = record.base_resp;
  if (!baseResp || typeof baseResp !== "object" || Array.isArray(baseResp)) {
    throw new Error("MiniMax search response omitted base_resp.");
  }
  const baseRecord = baseResp as Record<string, unknown>;
  const statusCode = baseRecord.status_code;
  const statusMessage = boundedString(baseRecord.status_msg, 300);
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) {
    throw new Error("MiniMax search response contained an invalid status code.");
  }
  if (statusCode !== 0) {
    const hint = statusCode === 1004
      ? " Check the API key and selected region."
      : statusCode === 2038
        ? " Complete MiniMax real-name verification for this account."
        : "";
    const trace = traceId ? ` Trace-Id: ${traceId}.` : "";
    throw new Error(`MiniMax API error ${statusCode}${statusMessage ? `: ${statusMessage}` : "."}${hint}${trace}`);
  }

  const organicValue = record.organic ?? [];
  const relatedValue = record.related_searches ?? [];
  if (!Array.isArray(organicValue) || !Array.isArray(relatedValue)) {
    throw new Error("MiniMax search response contained invalid result arrays.");
  }

  const organic: NormalizedSearchResult[] = [];
  for (const item of organicValue.slice(0, MAX_RESULTS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const result = item as Record<string, unknown>;
    const title = boundedString(result.title, 300);
    const link = httpUrl(result.link);
    if (!title || !link) continue;
    organic.push({
      title,
      link,
      snippet: boundedString(result.snippet, 1_200),
      date: boundedString(result.date, 80),
    });
  }

  const related_searches: Array<{ query: string }> = [];
  for (const item of relatedValue.slice(0, MAX_RELATED_SEARCHES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const query = boundedString((item as Record<string, unknown>).query, 300);
    if (query) related_searches.push({ query });
  }

  return {
    organic,
    related_searches,
    base_resp: { status_code: 0, status_msg: statusMessage },
    trace_id: traceId,
    truncated: organicValue.length > MAX_RESULTS || relatedValue.length > MAX_RELATED_SEARCHES,
  };
}

function maskApiKey(apiKey: string): string {
  return apiKey.length <= 8 ? "********" : `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

// ─── Extension Registration ───────────────────────────────────────────────────

export function createMinimaxExtension(overrides: Partial<ExtensionDependencies> = {}) {
  const dependencies: ExtensionDependencies = {
    resolveCredentials,
    postJson,
    ...overrides,
  };

  return function registerMinimaxExtension(pi: ExtensionAPI) {
    // ── Command: /set-minimax-key ───────────────────────────────────────────

    pi.registerCommand("set-minimax-key", {
      description: "Configure your own MiniMax API key (overrides Pi credentials)",
      getArgumentCompletions: (_prefix) => [
        { value: "global", label: "global", description: "Use global endpoint (api.minimax.io)" },
        { value: "cn", label: "cn", description: "Use China endpoint (api.minimaxi.com)" },
      ],
      handler: async (args, ctx) => {
        const parts = args.trim().split(/\s+/);
        const apiKey = parts[0];
        const region = parts[1]?.toLowerCase();

        if (!apiKey) {
          ctx.ui.notify("Usage: /set-minimax-key <api-key> [global|cn]", "error");
          return;
        }
        if (region && region !== "global" && region !== "cn") {
          ctx.ui.notify("Region must be global or cn.", "error");
          return;
        }

        const apiHost = region === "cn" ? CN_API_HOST : GLOBAL_API_HOST;
        saveCredentials(apiKey, apiHost);
        ctx.ui.notify("MiniMax API key saved! Use /minimax-status to verify.", "info");
      },
    });

    // ── Command: /minimax-status ────────────────────────────────────────────

    pi.registerCommand("minimax-status", {
      description: "Check MiniMax API key status",
      handler: async (_args, ctx) => {
        try {
          const creds = await dependencies.resolveCredentials(ctx);
          if (creds) {
            ctx.ui.notify(
              `MiniMax: Using ${creds.source}\nRegion: ${creds.region}\nKey: ${maskApiKey(creds.apiKey)}\nHost: ${creds.apiHost}`,
              "info",
            );
          } else {
            ctx.ui.notify(
              "MiniMax: No API key configured.\nUse Pi /login or set with: /set-minimax-key <key> [global|cn]",
              "warning",
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`MiniMax credential error: ${message}`, "error");
        }
      },
    });

    // ── Command: /minimax-clear-key ────────────────────────────────────────

    pi.registerCommand("minimax-clear-key", {
      description: "Clear the custom key and use Pi-resolved credentials",
      handler: async (_args, ctx) => {
        const credsPath = getCredsPath();
        if (fs.existsSync(credsPath)) {
          fs.unlinkSync(credsPath);
          ctx.ui.notify("Custom key cleared. Pi credentials will be used if available.", "info");
        } else {
          ctx.ui.notify("No custom key to clear.", "info");
        }
      },
    });

    // ── Tool: web_search ───────────────────────────────────────────────────

    pi.registerTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web for up-to-date information. Returns at most 10 results with bounded titles, URLs, snippets, and optional related queries. Use when you need current information not in your training data.",
      promptSnippet: "Web search for current information",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 1_000, description: "The search query" }),
        related: Type.Optional(Type.Boolean({ description: "Include related searches" })),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const query = params.query.trim();
        if (!query) throw new Error("MiniMax web search requires a non-empty query.");

        try {
          const creds = await dependencies.resolveCredentials(ctx);
          if (!creds) {
            throw new Error("No MiniMax API key available. Use Pi /login or /set-minimax-key <api-key> [global|cn].");
          }

          onUpdate?.({
            content: [{ type: "text", text: "Searching web..." }],
            details: { phase: "searching" },
          });

          const response = await dependencies.postJson<unknown>(
            `${creds.apiHost}/v1/coding_plan/search`,
            { q: query },
            creds.apiKey,
            signal,
          );
          const data = normalizeSearchResponse(response.data, response.traceId);

          if (data.organic.length === 0) {
            return {
              content: [{ type: "text", text: "No search results found." }],
              details: data,
            };
          }

          const lines = [`Search results for "${query}":`, ""];
          for (let index = 0; index < data.organic.length; index++) {
            const item = data.organic[index];
            lines.push(`${index + 1}. ${item.title}`, `   ${item.link}`);
            if (item.date) lines.push(`   ${item.date}`);
            if (item.snippet) lines.push(`   ${item.snippet}`);
            lines.push("");
          }
          if (params.related && data.related_searches.length > 0) {
            lines.push(`Related: ${data.related_searches.map((item) => item.query).join(", ")}`);
          }

          const output = truncateUtf8(lines.join("\n"), MAX_OUTPUT_BYTES, "\n\n[Search output truncated]");
          return {
            content: [{ type: "text", text: output }],
            details: data,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`MiniMax web search failed: ${message}`);
        }
      },
    });
  };
}

export default createMinimaxExtension();
