import assert from "node:assert/strict";

import path from "node:path";

import { after, before, describe, test } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { startMockOllama } from "./helpers/mock-ollama.js";

import { createFileTree, removeCreatedTrees, startHttpServer, text, WORK_DIR } from "./helpers/server.js";

process.chdir(WORK_DIR);

after(removeCreatedTrees);

async function connect(url, { mode = "auto", headers } = {}) {
  const client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode } });

  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });

  await client.connect(transport);

  return client;
}

async function post(url, { body, headers = {} } = {}) {
  return fetch(`${url}/mcp`, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",

      Accept: "application/json, text/event-stream",

      ...headers,
    },

    body,
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",

  id: 1,

  method: "initialize",

  params: {
    protocolVersion: "2025-06-18",

    capabilities: {},

    clientInfo: { name: "test", version: "0" },
  },
});

describe("認証なしの HTTP", () => {
  let ollama;

  let server;

  before(async () => {
    ollama = await startMockOllama();

    server = await startHttpServer({ OLLAMA_URL: ollama.url, DEFAULT_MODEL: "mock:latest" });
  });

  after(async () => {
    await server.stop();

    await ollama.close();
  });

  for (const mode of ["legacy", "auto"]) {
    test(`${mode}: ツールの一覧と呼び出し`, async () => {
      const client = await connect(server.url, { mode });

      try {
        const { tools } = await client.listTools();

        assert.deepEqual(tools.map((t) => t.name).sort(), [
          "ollama_chat",
          "ollama_explain_error",
          "ollama_health",
          "ollama_list_models",
          "ollama_review_code",
        ]);

        const result = await client.callTool({ name: "ollama_chat", arguments: { prompt: "hello" } });

        assert.ok(!result.isError, text(result));

        assert.match(text(result), /chunk0 chunk1 chunk2/);

        assert.match(text(result), /\[ollama\] model=mock:latest .*done_reason=stop/);
      } finally {
        await client.close();
      }
    });
  }

  test("未知の引数とファイルの引数は拒む", async () => {
    const client = await connect(server.url);

    try {
      const unknown = await client.callTool({ name: "ollama_chat", arguments: { prompt: "x", maxTokens: 1 } });

      assert.equal(unknown.isError, true);

      const files = await client.callTool({ name: "ollama_chat", arguments: { prompt: "x", files: ["/etc/passwd"] } });

      assert.equal(files.isError, true);
    } finally {
      await client.close();
    }
  });

  test("Ollama の失敗は isError で返す", async () => {
    const client = await connect(server.url);

    try {
      const result = await client.callTool({ name: "ollama_chat", arguments: { prompt: "MOCK_ERROR" } });

      assert.equal(result.isError, true);

      assert.match(text(result), /HTTP 500: mock failure/);
    } finally {
      await client.close();
    }
  });

  test("クライアントが中断すると Ollama への呼び出しも止まる", async () => {
    const client = await connect(server.url);

    try {
      const controller = new AbortController();

      setTimeout(() => controller.abort(), 500);

      await assert.rejects(
        client.callTool({ name: "ollama_chat", arguments: { prompt: "MOCK_SLOW" } }, { signal: controller.signal }),
      );

      const deadline = Date.now() + 5000;

      while (ollama.state.aborted === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(ollama.state.aborted > 0, "mock Ollama did not see the request aborted");
    } finally {
      await client.close();
    }
  });

  test("HTTP のエラーは JSON-RPC の形で返す", async () => {
    const get = await fetch(`${server.url}/mcp`);

    assert.equal(get.status, 405);

    const plain = await post(server.url, { body: "hello", headers: { "Content-Type": "text/plain" } });

    assert.equal(plain.status, 415);

    const broken = await post(server.url, { body: '{"jsonrpc":' });

    assert.equal(broken.status, 400);

    assert.equal((await broken.json()).error.code, -32700);

    const unknownMethod = await post(server.url, { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "foo/bar" }) });

    assert.match(await unknownMethod.text(), /-32601/);
  });

  test("許可していない Host と Origin は 403", async () => {
    const response = await fetch(`${server.url}/mcp`, {
      method: "POST",

      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },

      body: INITIALIZE,
    });

    assert.equal(response.status, 403);
  });

  test("通知には 202 を返す", async () => {
    const response = await post(server.url, {
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    assert.equal(response.status, 202);
  });
});

describe("トークンで認証する HTTP（ファイルの読み込みあり）", () => {
  let ollama;

  let server;

  let root;

  before(async () => {
    ollama = await startMockOllama();

    root = createFileTree();

    server = await startHttpServer({
      OLLAMA_URL: ollama.url,

      MCP_AUTH_TOKEN: "test-token",

      HTTP_ALLOW_FILES: "true",

      FILE_ROOTS: root,
    });
  });

  after(async () => {
    await server.stop();

    await ollama.close();
  });

  test("トークンがなければ 401", async () => {
    const response = await post(server.url, { body: INITIALIZE });

    assert.equal(response.status, 401);
  });

  test("トークンがあれば、ファイルのツールを使える", async () => {
    const client = await connect(server.url, { headers: { Authorization: "Bearer test-token" } });

    try {
      const { tools } = await client.listTools();

      assert.ok(tools.some((t) => t.name === "list_files"));

      const listing = await client.callTool({ name: "list_files", arguments: { path: root } });

      assert.match(text(listing), /app/);

      const result = await client.callTool({
        name: "ollama_review_code",

        arguments: { files: [path.join(root, "app", "src", "Main.php")] },
      });

      assert.match(text(result), /FILES=1/);

      const secret = await client.callTool({
        name: "ollama_chat",

        arguments: { prompt: "x", files: [path.join(root, "app", ".env")] },
      });

      assert.equal(secret.isError, true);
    } finally {
      await client.close();
    }
  });
});

describe("認証なしで HTTP_ALLOW_FILES=true にしたとき", () => {
  let server;

  before(async () => {
    server = await startHttpServer({
      OLLAMA_URL: "http://127.0.0.1:9",

      HTTP_ALLOW_FILES: "true",

      FILE_ROOTS: createFileTree(),
    });
  });

  after(() => server.stop());

  test("ファイルのツールは無効のままにし、警告を出す", async () => {
    assert.match(server.output(), /HTTP_ALLOW_FILES=true is ignored/);

    const client = await connect(server.url);

    try {
      const { tools } = await client.listTools();

      assert.ok(!tools.some((t) => t.name === "list_files"));
    } finally {
      await client.close();
    }
  });
});

describe("タイムアウト", () => {
  let ollama;

  let server;

  before(async () => {
    ollama = await startMockOllama();

    server = await startHttpServer({ OLLAMA_URL: ollama.url, OLLAMA_MAX_DURATION: "1000" });
  });

  after(async () => {
    await server.stop();

    await ollama.close();
  });

  test("途中まで生成された部分を警告付きで返す", async () => {
    const client = await connect(server.url);

    try {
      const result = await client.callTool({ name: "ollama_chat", arguments: { prompt: "MOCK_SLOW" } });

      assert.ok(!result.isError, text(result));

      assert.match(text(result), /chunk0/);

      assert.match(text(result), /done_reason=timeout/);

      assert.match(text(result), /WARNING: .*OLLAMA_MAX_DURATION/);

      // タイムアウトで Ollama への呼び出しも止まったこと
      const deadline = Date.now() + 5000;

      while (ollama.state.aborted === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok(ollama.state.aborted > 0, "mock Ollama did not see the request aborted");
    } finally {
      await client.close();
    }
  });
});
