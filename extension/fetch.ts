/**
 * HTTP fetching with content negotiation and Markdown sniffing.
 * Inspired by SuPi web extension: https://github.com/mrclrchtr/supi
 */

import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import Turndown from "turndown";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const USER_AGENT = "Mozilla/5.0 (compatible; pi-minimax-fetch/1.0; +https://github.com/Changhochien/websearch-and-image-understanding-using-minimax)";
const ACCEPT_SIBLING = "text/markdown,text/plain;q=0.9,*/*;q=0.1";
const DEFAULT_TIMEOUT_MS = 30_000;
const SNIFF_BYTES = 8192;
const DANGEROUS_SCHEMES = ["javascript:", "data:", "vbscript:", "file:"];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FetchResult {
  url: string;
  text: string;
  contentType: string;
  isMarkdown: boolean;
  isPlainText: boolean;
}

export interface FetchOptions {
  timeoutMs?: number;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

// ─── URL Validation ───────────────────────────────────────────────────────────

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

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

export function validateUrl(raw: string): URL {
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

// ─── Content Type Detection ───────────────────────────────────────────────────

function isMarkdownContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return (
    lower.includes("text/markdown") ||
    lower.includes("text/x-markdown") ||
    lower.includes("application/markdown") ||
    lower.includes("application/x-markdown")
  );
}

function isHtmlContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}

export function isPlainTextContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  if (isHtmlContentType(ct)) return false;
  return lower.startsWith("text/") || lower.includes("application/xml");
}

export function isHtml(text: string): boolean {
  const trimmed = (text || "").trimStart().slice(0, 2000).toLowerCase();
  return !!(
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<head") ||
    trimmed.startsWith("<body")
  );
}

function looksLikeMarkdown(text: string): boolean {
  const sample = (text || "").slice(0, 4000);
  return !!(
    /^\s*#\s+\S+/m.test(sample) ||
    /^\s*---\s*$/m.test(sample) ||
    /```/.test(sample) ||
    /^\s*[-*+]\s+\S+/m.test(sample) ||
    /^\s*\d+\.\s+\S+/m.test(sample) ||
    /\[[^\]]+\]\([^)]+\)/.test(sample)
  );
}

function looksLikeMarkdownUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".md") || path.endsWith(".markdown");
  } catch {
    return false;
  }
}

function generateSiblingUrls(url: string): string[] {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  const pathname = parsed.pathname;
  const siblings: string[] = [];

  if (pathname.endsWith("/")) {
    siblings.push(new URL("index.md", parsed).toString());
    siblings.push(new URL("README.md", parsed).toString());
  } else if (!pathname.toLowerCase().endsWith(".md")) {
    const withMd = new URL(parsed.toString());
    withMd.pathname = `${pathname}.md`;
    siblings.push(withMd.toString());
  }

  const withMarkdown = new URL(parsed.toString());
  if (!pathname.toLowerCase().endsWith(".markdown")) {
    withMarkdown.pathname = pathname.endsWith("/")
      ? `${pathname}index.markdown`
      : `${pathname}.markdown`;
    siblings.push(withMarkdown.toString());
  }

  return siblings;
}

// ─── Language Detection for Code Blocks ─────────────────────────────────────

export function guessLanguage(url: string): string {
  try {
    const ext = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
    const map: Record<string, string> = {
      bash: "bash", c: "c", cc: "cpp", conf: "conf", cpp: "cpp",
      css: "css", cxx: "cpp", dart: "dart", dockerfile: "dockerfile",
      elixir: "elixir", ex: "elixir", exs: "elixir", go: "go",
      graphql: "graphql", gql: "graphql", h: "c", hpp: "cpp",
      html: "html", htm: "html", ini: "ini", java: "java",
      js: "javascript", json: "json", jsx: "jsx", kt: "kotlin",
      kts: "kotlin", less: "less", lua: "lua", mjs: "javascript",
      cjs: "javascript", md: "markdown", php: "php", pl: "perl",
      ps: "powershell", ps1: "powershell", py: "python", r: "r",
      rb: "ruby", rs: "rust", scss: "scss", sh: "sh",
      sql: "sql", svelte: "svelte", swift: "swift", toml: "toml",
      ts: "ts", tsx: "tsx", vue: "vue", yaml: "yaml",
      yml: "yaml", xml: "xml", zsh: "zsh",
    };
    return map[ext] || "";
  } catch {
    return "";
  }
}

// ─── Timed Fetch ─────────────────────────────────────────────────────────────

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readPartialText(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (body && typeof (body as unknown as { getReader: () => unknown }).getReader === "function") {
    const reader = (body as unknown as ReadableStream).getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let bytes = 0;
    try {
      while (bytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        bytes += value.byteLength;
        if (bytes >= maxBytes) break;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    return (text + decoder.decode()).slice(0, Math.max(0, maxBytes));
  }
  return (await res.text()).slice(0, Math.max(0, maxBytes));
}

// ─── Negotiation Strategies ───────────────────────────────────────────────────

async function tryHeadNegotiation(url: string, timeoutMs: number): Promise<FetchResult | null> {
  try {
    const headRes = await timedFetch(
      url,
      { method: "HEAD", redirect: "follow", headers: { "User-Agent": USER_AGENT } },
      timeoutMs,
    );
    if (!headRes.ok) return null;
    const ct = headRes.headers.get("content-type") || "";
    if (!isMarkdownContentType(ct)) return null;

    const getRes = await timedFetch(
      url,
      { method: "GET", redirect: "follow", headers: { "User-Agent": USER_AGENT } },
      timeoutMs,
    );
    if (!getRes.ok)
      throw new FetchError(`Fetch failed: ${getRes.status} ${getRes.statusText}`, getRes.status);
    return {
      url: getRes.url || url,
      text: await getRes.text(),
      contentType: ct,
      isMarkdown: true,
      isPlainText: false,
    };
  } catch {
    return null;
  }
}

async function trySniffNegotiation(url: string, timeoutMs: number): Promise<FetchResult | null> {
  try {
    const sniffRes = await timedFetch(
      url,
      {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Range: `bytes=0-${SNIFF_BYTES - 1}` },
      },
      timeoutMs,
    );
    const sniffText = await readPartialText(sniffRes, SNIFF_BYTES);
    const ct = sniffRes.headers.get("content-type") || "";
    const finalUrl = sniffRes.url || url;

    if (!sniffRes.ok || isHtml(sniffText)) return null;

    if (
      isMarkdownContentType(ct) ||
      looksLikeMarkdownUrl(finalUrl) ||
      looksLikeMarkdown(sniffText)
    ) {
      const fullRes = await timedFetch(
        url,
        { method: "GET", redirect: "follow", headers: { "User-Agent": USER_AGENT } },
        timeoutMs,
      );
      if (!fullRes.ok)
        throw new FetchError(
          `Fetch failed: ${fullRes.status} ${fullRes.statusText}`,
          fullRes.status,
        );
      return {
        url: fullRes.url || url,
        text: await fullRes.text(),
        contentType: ct,
        isMarkdown: true,
        isPlainText: false,
      };
    }

    if (
      isPlainTextContentType(ct) &&
      !looksLikeMarkdownUrl(finalUrl) &&
      !looksLikeMarkdown(sniffText)
    ) {
      const fullRes = await timedFetch(
        url,
        { method: "GET", redirect: "follow", headers: { "User-Agent": USER_AGENT } },
        timeoutMs,
      );
      if (!fullRes.ok)
        throw new FetchError(
          `Fetch failed: ${fullRes.status} ${fullRes.statusText}`,
          fullRes.status,
        );
      return {
        url: fullRes.url || url,
        text: await fullRes.text(),
        contentType: ct,
        isMarkdown: false,
        isPlainText: true,
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function trySiblingNegotiation(url: string, timeoutMs: number): Promise<FetchResult | null> {
  for (const sibling of generateSiblingUrls(url)) {
    try {
      const sibRes = await timedFetch(
        sibling,
        {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": USER_AGENT, Accept: ACCEPT_SIBLING },
        },
        timeoutMs,
      );
      const sibText = await readPartialText(sibRes, SNIFF_BYTES);
      const sibCt = sibRes.headers.get("content-type") || "";
      if (!sibRes.ok || isHtml(sibText) || isHtmlContentType(sibCt)) continue;
      if (!looksLikeMarkdown(sibText) && !isMarkdownContentType(sibCt)) continue;

      const fullRes = await timedFetch(
        sibling,
        {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": USER_AGENT, Accept: ACCEPT_SIBLING },
        },
        timeoutMs,
      );
      if (!fullRes.ok) continue;
      return {
        url: fullRes.url || sibling,
        text: await fullRes.text(),
        contentType: sibCt,
        isMarkdown: true,
        isPlainText: false,
      };
    } catch {
      // Try next sibling
    }
  }
  return null;
}

// ─── Main Fetch Function ──────────────────────────────────────────────────────

export async function fetchWithNegotiation(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1. Try HEAD negotiation for Markdown
  const headResult = await tryHeadNegotiation(url, timeoutMs);
  if (headResult) return headResult;

  // 2. Range GET to sniff content type
  const sniffResult = await trySniffNegotiation(url, timeoutMs);
  if (sniffResult) return sniffResult;

  // 3. Try sibling .md URLs
  const siblingResult = await trySiblingNegotiation(url, timeoutMs);
  if (siblingResult) return siblingResult;

  // 4. Full GET as HTML → convert to Markdown
  return fetchAsHtml(url, timeoutMs);
}

async function fetchAsHtml(url: string, timeoutMs: number): Promise<FetchResult> {
  const res = await timedFetch(
    url,
    {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.1" },
    },
    timeoutMs,
  );
  if (!res.ok) throw new FetchError(`Fetch failed: ${res.status} ${res.statusText}`, res.status);
  return {
    url: res.url || url,
    text: await res.text(),
    contentType: res.headers.get("content-type") || "",
    isMarkdown: false,
    isPlainText: false,
  };
}

// ─── HTML → Markdown Conversion ──────────────────────────────────────────────

function absolutizeLinks(root: Element, baseUrl: string): void {
  for (const a of root.querySelectorAll("a[href]")) {
    const resolved = resolveUrl(a.getAttribute("href") || "", baseUrl);
    if (resolved) {
      a.setAttribute("href", resolved);
    } else {
      a.removeAttribute("href");
    }
  }
  for (const img of root.querySelectorAll("img[src]")) {
    const resolved = resolveUrl(img.getAttribute("src") || "", baseUrl);
    if (resolved) {
      img.setAttribute("src", resolved);
    } else {
      img.removeAttribute("src");
    }
  }
}

function resolveUrl(href: string, baseUrl: string): string {
  const trimmed = String(href || "").trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:")
  ) {
    return trimmed;
  }
  // Check for dangerous schemes
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex !== -1) {
    const scheme = trimmed.slice(0, colonIndex + 1).toLowerCase();
    if (DANGEROUS_SCHEMES.includes(scheme)) {
      return "";
    }
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return "";
    }
    return resolved.toString();
  } catch {
    return trimmed;
  }
}

function cleanMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      out.push(raw);
      continue;
    }
    if (
      !inCodeBlock &&
      (/^(copy|copy page|copied!?|copy to clipboard)$/i.test(trimmed) ||
        /^loading\.{3}$/i.test(trimmed))
    ) {
      continue;
    }
    out.push(raw);
  }

  return out.join("\n");
}

function normalizeWhitespace(text: string): string {
  return `${String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

export function wrapAsCodeBlock(text: string, url: string): string {
  const lang = guessLanguage(url);
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Find longest backtick sequence so we can choose a fence that won't conflict
  const backticks = normalized.match(/`+/g) || [];
  let maxTicks = 0;
  for (const bt of backticks) {
    maxTicks = Math.max(maxTicks, bt.length);
  }
  const fence = "`".repeat(Math.max(3, maxTicks + 1));
  const body = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  const prefix = lang ? `${fence}${lang}\n` : `${fence}\n`;
  return normalizeWhitespace(`${prefix}${body}${fence}\n`);
}

function createDocument(html: string, url: string): Document {
  const virtualConsole = new VirtualConsole();
  return new JSDOM(html, { url, virtualConsole }).window.document;
}

export async function htmlToMarkdown(
  html: string,
  baseUrl: string,
  options: { absLinks?: boolean } = {},
): Promise<string> {
  const absLinks = options.absLinks ?? true;

  if (!isHtml(html)) {
    return wrapAsCodeBlock(html, baseUrl);
  }

  const doc = createDocument(html, baseUrl);

  // Remove script/style/noscript
  for (const tag of ["script", "style", "noscript"]) {
    for (const el of doc.querySelectorAll(tag)) {
      el.remove();
    }
  }

  // Extract article content with Readability
  const readability = new Readability(doc);
  const article = readability.parse();

  const title = article?.title?.trim() || doc.title?.trim() || "";

  // Use Readability content, or fall back to body
  const contentHtml = article?.content || doc.body?.innerHTML || html;

  // Re-parse content so we can manipulate it cleanly
  const contentDoc = createDocument(`${contentHtml}`, baseUrl);
  const body = contentDoc.body;

  if (absLinks) {
    absolutizeLinks(body, baseUrl);
  }

  const turndown = await createTurndown();
  let markdown = turndown.turndown(body);
  markdown = cleanMarkdown(markdown);

  // Prepend title if not already present
  if (title && !markdown.trimStart().startsWith("# ")) {
    markdown = `# ${title}\n\n${markdown}`;
  }

  return normalizeWhitespace(markdown);
}

async function createTurndown(): Promise<Turndown> {
  const td = new Turndown({
    codeBlockStyle: "fenced",
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    emDelimiter: "_",
  });

  // Load GFM plugins
  try {
    // @ts-ignore — turndown-plugin-gfm has no @types package
    const gfmMod = await import("turndown-plugin-gfm");
    const gfm = (gfmMod as unknown as { default?: unknown }).default ?? gfmMod;
    const plugins: unknown[] = [];
    if (gfm && typeof gfm === "object") {
      const obj = gfm as Record<string, unknown>;
      if (typeof obj.gfm === "function") plugins.push(obj.gfm);
      if (typeof obj.tables === "function") plugins.push(obj.tables);
      if (typeof obj.strikethrough === "function") plugins.push(obj.strikethrough);
      if (typeof obj.taskListItems === "function") plugins.push(obj.taskListItems);
    }
    if (plugins.length > 0) {
      td.use(plugins as [(turndown: Turndown) => void]);
    }
  } catch {
    // GFM plugin optional
  }

  // Custom pre → fenced code rule
  td.addRule("preToFenced", {
    filter: ["pre"],
    replacement(_content: string, node: Turndown.Node) {
      const text = (node as unknown as HTMLElement).textContent ?? "";
      return `\n\n\`\`\`\n${String(text).replace(/\n+$/g, "")}\n\`\`\`\n\n`;
    },
  });

  return td;
}

// ─── Temp File Helper ────────────────────────────────────────────────────────

export function writeTempFile(content: string, prefix: string, ext: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const filePath = path.join(tmpDir, `content${ext}`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}
