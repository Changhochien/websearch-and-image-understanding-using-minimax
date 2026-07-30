import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createMinimaxExtension,
  normalizeApiHost,
  normalizeSearchResponse,
  postJson,
  resolvePiCredentials,
} from "../extension/index.ts";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const credentials = {
  apiKey: "test-key",
  apiHost: "https://api.minimax.io",
  region: "global",
  source: "test",
};

function registerWith(overrides = {}) {
  const tools = [];
  const commands = [];
  createMinimaxExtension({
    resolveCredentials: async () => credentials,
    postJson: async () => ({
      data: { organic: [], related_searches: [], base_resp: { status_code: 0 } },
    }),
    ...overrides,
  })({
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, command) {
      commands.push({ name, command });
    },
  });
  return { tools, commands };
}

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test("registers only the MiniMax web_search tool", () => {
  const { tools, commands } = registerWith();
  assert.deepEqual(tools.map((tool) => tool.name), ["web_search"]);
  assert.deepEqual(commands.map((command) => command.name), [
    "set-minimax-key",
    "minimax-status",
    "minimax-clear-key",
  ]);
});

test("web_search trims queries, forwards cancellation, and returns bounded normalized fields", async () => {
  const calls = [];
  const updates = [];
  const { tools } = registerWith({
    postJson: async (url, body, apiKey, signal) => {
      calls.push({ url, body, apiKey, signal });
      return {
        traceId: "trace-1",
        data: {
          organic: [{
            title: "Result",
            link: "https://example.com/path",
            snippet: "Snippet",
            date: "2026-07-30",
          }],
          related_searches: [{ query: "related query" }],
          base_resp: { status_code: 0, status_msg: "ok" },
        },
      };
    },
  });
  const controller = new AbortController();
  const result = await tools[0].execute(
    "call-1",
    { query: "  current information  ", related: true },
    controller.signal,
    (update) => updates.push(update),
    {},
  );

  assert.equal(calls[0].url, "https://api.minimax.io/v1/coding_plan/search");
  assert.deepEqual(calls[0].body, { q: "current information" });
  assert.equal(calls[0].apiKey, "test-key");
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(updates[0].details.phase, "searching");
  assert.match(result.content[0].text, /2026-07-30/);
  assert.match(result.content[0].text, /Related: related query/);
  assert.equal(result.details.trace_id, "trace-1");
});

test("web_search caps large UTF-8 output and reports truncation", async () => {
  const { tools } = registerWith({
    postJson: async () => ({
      data: {
        organic: Array.from({ length: 10 }, (_, index) => ({
          title: `Result ${index}`,
          link: `https://example.com/${index}`,
          snippet: "界".repeat(1_200),
        })),
        related_searches: [],
        base_resp: { status_code: 0 },
      },
    }),
  });
  const result = await tools[0].execute("call-large", { query: "large" }, undefined, undefined, {});
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 30_000);
  assert.match(result.content[0].text, /\[Search output truncated\]$/);
});

test("web_search throws failures so Pi marks the tool result as an error", async () => {
  const { tools } = registerWith({ resolveCredentials: async () => null });
  await assert.rejects(
    tools[0].execute("call-2", { query: "news" }, undefined, undefined, {}),
    /MiniMax web search failed: No MiniMax API key available/,
  );
  await assert.rejects(
    tools[0].execute("call-3", { query: "   " }, undefined, undefined, {}),
    /requires a non-empty query/,
  );
});

test("resolves MiniMax credentials through Pi ModelRegistry with global precedence", async () => {
  const calls = [];
  const global = await resolvePiCredentials({
    modelRegistry: {
      async getProviderAuth(provider) {
        calls.push(provider);
        return provider === "minimax"
          ? { auth: { apiKey: " global-key " }, source: "stored API key" }
          : undefined;
      },
    },
  });
  assert.deepEqual(calls, ["minimax"]);
  assert.deepEqual(global, {
    apiKey: "global-key",
    apiHost: "https://api.minimax.io",
    region: "global",
    source: "stored API key",
  });

  const cnCalls = [];
  const cn = await resolvePiCredentials({
    modelRegistry: {
      async getProviderAuth(provider) {
        cnCalls.push(provider);
        return provider === "minimax-cn"
          ? { auth: { apiKey: "cn-key" }, source: "MINIMAX_CN_API_KEY" }
          : undefined;
      },
    },
  });
  assert.deepEqual(cnCalls, ["minimax", "minimax-cn"]);
  assert.equal(cn.region, "cn");
  assert.equal(cn.source, "MINIMAX_CN_API_KEY");
});

test("accepts only official MiniMax HTTPS hosts", () => {
  assert.deepEqual(normalizeApiHost("https://api.minimax.io/anthropic"), {
    apiHost: "https://api.minimax.io",
    region: "global",
  });
  assert.deepEqual(normalizeApiHost("https://api.minimaxi.com/v1"), {
    apiHost: "https://api.minimaxi.com",
    region: "cn",
  });
  assert.throws(() => normalizeApiHost("http://api.minimax.io"), /HTTPS/);
  assert.throws(() => normalizeApiHost("https://example.com"), /must be api\.minimax/);
});

test("normalizes and caps MiniMax result arrays and field lengths", () => {
  const organic = Array.from({ length: 12 }, (_, index) => ({
    title: `Result ${index} ${"t".repeat(400)}`,
    link: `https://example.com/${index}`,
    snippet: "界".repeat(2_000),
    date: "d".repeat(100),
  }));
  const related = Array.from({ length: 12 }, (_, index) => ({ query: `query-${index}-${"q".repeat(400)}` }));
  const result = normalizeSearchResponse({
    organic,
    related_searches: related,
    base_resp: { status_code: 0, status_msg: "ok" },
  });

  assert.equal(result.organic.length, 10);
  assert.equal(result.related_searches.length, 10);
  assert.equal(result.organic[0].title.length, 300);
  assert.equal(result.organic[0].snippet.length, 1_200);
  assert.equal(result.organic[0].date.length, 80);
  assert.equal(result.related_searches[0].query.length, 300);
  assert.equal(result.truncated, true);
});

test("rejects missing or failed MiniMax base responses with actionable context", () => {
  assert.throws(
    () => normalizeSearchResponse({ organic: [], related_searches: [] }),
    /omitted base_resp/,
  );
  assert.throws(
    () => normalizeSearchResponse({ base_resp: { status_code: 1004, status_msg: "invalid key" } }, "trace-auth"),
    /invalid key.*Check the API key and selected region.*trace-auth/,
  );
  assert.throws(
    () => normalizeSearchResponse({ base_resp: { status_code: 2038, status_msg: "verification required" } }),
    /real-name verification/,
  );
});

test("postJson returns parsed JSON and trace IDs", async () => {
  await withServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer secret-key");
    response.setHeader("Trace-Id", "trace-http");
    response.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const result = await postJson(`${baseUrl}/search`, { q: "test" }, "secret-key");
    assert.deepEqual(result, { data: { ok: true }, traceId: "trace-http" });
  });
});

test("postJson rejects HTTP errors, redacts credentials, and includes trace IDs", async () => {
  await withServer((_request, response) => {
    response.statusCode = 401;
    response.setHeader("Trace-Id", "trace-401");
    response.end("invalid secret-key");
  }, async (baseUrl) => {
    await assert.rejects(
      postJson(`${baseUrl}/search`, {}, "secret-key"),
      (error) => {
        assert.match(error.message, /MiniMax HTTP 401/);
        assert.match(error.message, /\[REDACTED\]/);
        assert.match(error.message, /trace-401/);
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      },
    );
  });
});

test("postJson rejects malformed and oversized responses", async () => {
  await withServer((_request, response) => response.end("not-json"), async (baseUrl) => {
    await assert.rejects(postJson(`${baseUrl}/search`, {}, "key"), /invalid JSON/);
  });

  await withServer((_request, response) => response.end("x".repeat(128)), async (baseUrl) => {
    await assert.rejects(
      postJson(`${baseUrl}/search`, {}, "key", undefined, { maxResponseBytes: 32 }),
      /exceeded 32 bytes/,
    );
  });
});

test("postJson honors caller cancellation and total deadlines", async () => {
  await withServer((request, response) => {
    const timer = setTimeout(() => response.end("{}"), 500);
    request.on("close", () => clearTimeout(timer));
  }, async (baseUrl) => {
    const controller = new AbortController();
    const pending = postJson(`${baseUrl}/search`, {}, "key", controller.signal, { timeoutMs: 1_000 });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /cancelled/);
  });

  await withServer((request, response) => {
    const timer = setTimeout(() => response.end("{}"), 500);
    request.on("close", () => clearTimeout(timer));
  }, async (baseUrl) => {
    await assert.rejects(
      postJson(`${baseUrl}/search`, {}, "key", undefined, { timeoutMs: 10 }),
      /timed out/,
    );
  });
});

test("saved custom credentials use restrictive permissions", async () => {
  if (process.platform === "win32") return;
  const home = await mkdtemp(join(tmpdir(), "minimax-credentials-"));
  try {
    const script = `
      import { loadCustomCredentials, saveCredentials } from ${JSON.stringify(new URL("../extension/index.ts", import.meta.url).href)};
      import { statSync } from "node:fs";
      import { join } from "node:path";
      saveCredentials("custom-key", "https://api.minimaxi.com/v1");
      const dir = join(process.env.HOME, ".config", "minimax-support");
      const file = join(dir, "creds.toml");
      console.log(JSON.stringify({ credentials: loadCustomCredentials(), dirMode: statSync(dir).mode & 0o777, fileMode: statSync(file).mode & 0o777 }));
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.credentials.apiKey, "custom-key");
    assert.equal(result.credentials.region, "cn");
    assert.equal(result.dirMode, 0o700);
    assert.equal(result.fileMode, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loading legacy credentials tightens permissions and rejects symlinks", async () => {
  if (process.platform === "win32") return;
  const home = await mkdtemp(join(tmpdir(), "minimax-legacy-credentials-"));
  try {
    const script = `
      import { loadCustomCredentials } from ${JSON.stringify(new URL("../extension/index.ts", import.meta.url).href)};
      import { chmodSync, mkdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const dir = join(process.env.HOME, ".config", "minimax-support");
      const file = join(dir, "creds.toml");
      const victim = join(process.env.HOME, "victim.toml");
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      writeFileSync(file, 'MINIMAX_API_KEY="legacy-key"\\nMINIMAX_API_HOST="https://api.minimax.io"\\n', { mode: 0o644 });
      chmodSync(dir, 0o755);
      chmodSync(file, 0o644);
      const credentials = loadCustomCredentials();
      const dirMode = statSync(dir).mode & 0o777;
      const fileMode = statSync(file).mode & 0o777;
      unlinkSync(file);
      writeFileSync(victim, 'MINIMAX_API_KEY="victim-key"\\n', { mode: 0o600 });
      symlinkSync(victim, file);
      let symlinkError = "";
      try { loadCustomCredentials(); } catch (error) { symlinkError = error.message; }
      console.log(JSON.stringify({ credentials, dirMode, fileMode, symlinkError }));
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.credentials.apiKey, "legacy-key");
    assert.equal(result.dirMode, 0o700);
    assert.equal(result.fileMode, 0o600);
    assert.match(result.symlinkError, /regular file, not a symlink/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("package metadata supports clean runtime installs and excludes development artifacts", () => {
  const child = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const [{ files }] = JSON.parse(child.stdout);
  const packed = files.map((file) => file.path);
  assert.ok(packed.includes("extension/index.ts"));
  assert.ok(packed.includes("SKILL.md"));
  assert.ok(packed.includes("tsconfig.json"));
  assert.ok(!packed.some((file) => file.startsWith("test/")));
  assert.ok(!packed.some((file) => file.startsWith(".pi-subagents/")));
});
