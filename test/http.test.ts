import assert from "node:assert/strict";

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";

import { request } from "node:http";

import { tmpdir } from "node:os";

import path from "node:path";

import { after, before, describe, test } from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { startMockOllama } from "./helpers/mock-ollama.ts";

import { createFileTree, removeCreatedTrees, startHttpServer, text, WORK_DIR } from "./helpers/server.ts";

process.chdir(WORK_DIR);

after(removeCreatedTrees);

async function connect(
  url: string,
  { mode = "auto", headers }: { mode?: "auto" | "legacy"; headers?: Record<string, string> } = {},
): Promise<Client> {
  const client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode } });

  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });

  await client.connect(transport);

  return client;
}

async function post(
  url: string,
  { body, headers = {} }: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
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
  let ollama: Awaited<ReturnType<typeof startMockOllama>>;

  let server: Awaited<ReturnType<typeof startHttpServer>>;

  before(async () => {
    ollama = await startMockOllama();

    server = await startHttpServer({ OLLAMA_URL: ollama.url, DEFAULT_MODEL: "mock:latest" });
  });

  after(async () => {
    await server.stop();

    await ollama.close();
  });

  // connect が受け取る値。文字列のままだと union に当たらない
  const modes = ["legacy", "auto"] as const;

  for (const mode of modes) {
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

    assert.equal(((await broken.json()) as { error: { code: number } }).error.code, -32700);

    const unknownMethod = await post(server.url, { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "foo/bar" }) });

    assert.match(await unknownMethod.text(), /-32601/);
  });

  test("既定では、要求を受け取り終えるまでを 60 秒で打ち切る", async () => {
    assert.match(server.output(), /\[http\] request timeout: 60 s/);
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
  let ollama: Awaited<ReturnType<typeof startMockOllama>>;

  let server: Awaited<ReturnType<typeof startHttpServer>>;

  let root: string;

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

  test("トークンがなければ、本文を読み終える前に 401 を返す", async () => {
    // 本文の長さだけを大きく名乗り、中身は送らない。
    // 認証より先に本文を解析すると、送り終えるまで（requestTimeout まで）応答が返らない
    const status = await new Promise<number>((resolve, reject) => {
      const { hostname, port } = new URL(server.url);

      const req = request(
        {
          hostname,
          port,
          path: "/mcp",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": "1000000" },
        },
        (res) => {
          res.resume();

          resolve(res.statusCode ?? 0);

          req.destroy();
        },
      );

      req.on("error", (error) => {
        // 応答を受け取ったあとで接続を切ったときの失敗は無視する
        if (!req.destroyed) {
          reject(error);
        }
      });

      req.setTimeout(5000, () => reject(new Error("no response before the body was sent")));

      req.write('{"jsonrpc":');
    });

    assert.equal(status, 401);

    // 壊れた JSON も、認証の無い相手には解析の結果（400）ではなく 401 を返す
    const broken = await post(server.url, { body: '{"jsonrpc":' });

    assert.equal(broken.status, 401);
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

      // 監査は 1 行の JSON で stderr に出る。識別子とツール名が入り、中身は入らない
      const entries = server
        .output()
        .split("\n")
        .filter((line) => line.includes('"kind":"tool"'))
        .map((line) => JSON.parse(line));

      const chat = entries.find((entry) => entry.tool === "ollama_chat" && entry.ok === false);

      assert.ok(chat, server.output());

      assert.equal(chat.identity, "token");

      assert.match(chat.error, /may contain secrets/);

      assert.equal("prompt" in chat.args, false);

      const review = entries.find((entry) => entry.tool === "ollama_review_code");

      assert.ok(review);

      assert.equal(review.ok, true);

      assert.equal(review.args.files.length, 1);
    } finally {
      await client.close();
    }
  });
});

describe("認証なしで HTTP_ALLOW_FILES=true にしたとき", () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;

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

      assert.ok(!tools.some((t) => t.name === "read_file"));
    } finally {
      await client.close();
    }
  });

  // resources/read にはツール名が無く、mcp__ollama__* の許可では止められない。
  // 認証がないときに能力ごと出ていないことを、ここで必ず確かめる
  test("resources も出さない", async () => {
    const client = await connect(server.url);

    try {
      assert.equal(client.getServerCapabilities()?.resources, undefined);

      await assert.rejects(client.readResource({ uri: "file:///work/dev/app/src/Main.php" }));
    } finally {
      await client.close();
    }
  });
});

describe("認証なしで HTTP_ALLOW_WRITES=true にしたとき", () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;

  let outDir: string;

  before(async () => {
    outDir = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-http-out-")));

    server = await startHttpServer({
      OLLAMA_URL: "http://127.0.0.1:9",

      OUTPUT_DIR: outDir,

      HTTP_ALLOW_WRITES: "true",
    });
  });

  after(async () => {
    await server.stop();

    rmSync(outDir, { recursive: true, force: true });
  });

  test("保存の引数は出さず、警告を出す", async () => {
    assert.match(server.output(), /HTTP_ALLOW_WRITES=true is ignored/);

    const client = await connect(server.url);

    try {
      const { tools } = await client.listTools();

      const chat = tools.find((t) => t.name === "ollama_chat");

      assert.equal(chat?.inputSchema.properties?.save_output, undefined);

      assert.notEqual(chat?.annotations?.readOnlyHint, false);
    } finally {
      await client.close();
    }
  });
});

describe("認証つきで HTTP_ALLOW_WRITES=true にしたとき", () => {
  let ollama: Awaited<ReturnType<typeof startMockOllama>>;

  let server: Awaited<ReturnType<typeof startHttpServer>>;

  let outDir: string;

  before(async () => {
    ollama = await startMockOllama();

    outDir = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-http-save-")));

    server = await startHttpServer({
      OLLAMA_URL: ollama.url,

      MCP_AUTH_TOKEN: "test-token",

      OUTPUT_DIR: outDir,

      HTTP_ALLOW_WRITES: "true",
    });
  });

  after(async () => {
    await server.stop();

    await ollama.close();

    rmSync(outDir, { recursive: true, force: true });
  });

  test("保存した結果はパスと抜粋だけを返す", async () => {
    const client = await connect(server.url, { headers: { Authorization: "Bearer test-token" } });

    try {
      const { tools } = await client.listTools();

      const chat = tools.find((t) => t.name === "ollama_chat");

      assert.ok(chat?.inputSchema.properties?.save_output);

      assert.equal(chat?.annotations?.readOnlyHint, false);

      const result = await client.callTool({
        name: "ollama_chat",

        arguments: { prompt: "hello", save_output: true, output_name: "draft" },
      });

      assert.match(text(result), /Saved: /);

      assert.match(text(result), /draft\.md/);

      assert.ok(existsSync(path.join(outDir, "draft.md")));

      // resource_link のブロックも付く
      const link = result.content.find((block) => block.type === "resource_link");

      assert.ok(link, JSON.stringify(result.content));

      assert.equal(link.name, "draft.md");
    } finally {
      await client.close();
    }
  });

  test("危ない output_name は拒む", async () => {
    const client = await connect(server.url, { headers: { Authorization: "Bearer test-token" } });

    try {
      for (const name of ["../escape", "NUL", "shell.php"]) {
        const result = await client.callTool({
          name: "ollama_chat",

          arguments: { prompt: "hello", save_output: true, output_name: name },
        });

        assert.equal(result.isError, true, name);
      }
    } finally {
      await client.close();
    }
  });
});

describe("HTTP では git と GitHub の書き込みを出さない", () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;

  let cloneRoot: string;

  before(async () => {
    cloneRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-http-clone-")));

    server = await startHttpServer({
      OLLAMA_URL: "http://127.0.0.1:9",

      MCP_AUTH_TOKEN: "test-token",

      CLONE_ROOT: cloneRoot,

      GIT_ALLOWED_OWNERS: "223n",

      // 書き込みを明示的に許した設定でも、HTTP には出てはいけない
      GIT_ALLOW_WRITE: "true",

      GITHUB_MCP_TOKEN: "test-token",

      GITHUB_ALLOW_WRITE: "true",
    });
  });

  after(async () => {
    await server.stop();

    rmSync(cloneRoot, { recursive: true, force: true });
  });

  test("読み取りは出すが、書き込みは出さない", async () => {
    assert.match(server.output(), /only take effect over stdio/);

    const client = await connect(server.url, { headers: { Authorization: "Bearer test-token" } });

    try {
      const names = (await client.listTools()).tools.map((t) => t.name);

      assert.ok(names.includes("git_clone"), names.join(", "));

      assert.ok(names.includes("git_read"));

      assert.ok(names.includes("github_read"));

      assert.ok(!names.includes("git_write"), names.join(", "));

      assert.ok(!names.includes("github_write"));

      // 登録していないので、呼び出しはツールが見つからないところで失敗する
      await assert.rejects(
        client.callTool({
          name: "git_write",

          arguments: { repo: "223n/x", op: "push", branch: "feature/y" },
        }),
        /git_write not found/,
      );
    } finally {
      await client.close();
    }
  });
});

describe("タイムアウト", () => {
  let ollama: Awaited<ReturnType<typeof startMockOllama>>;

  let server: Awaited<ReturnType<typeof startHttpServer>>;

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

describe("requestTimeout は応答の長さに効かない", () => {
  let ollama: Awaited<ReturnType<typeof startMockOllama>>;

  let server: Awaited<ReturnType<typeof startHttpServer>>;

  before(async () => {
    ollama = await startMockOllama();

    // 要求を受け取り終えるまでの上限を 2 秒にし、約 10 秒かかる生成を流す
    server = await startHttpServer({ OLLAMA_URL: ollama.url, HTTP_REQUEST_TIMEOUT: "2000" });
  });

  after(async () => {
    await server.stop();

    await ollama.close();
  });

  test("requestTimeout より長い生成も、途中で切れずに最後まで返る", async () => {
    assert.match(server.output(), /\[http\] request timeout: 2 s/);

    const client = await connect(server.url);

    try {
      const result = await client.callTool({ name: "ollama_chat", arguments: { prompt: "MOCK_SLOW" } });

      assert.ok(!result.isError, text(result));

      assert.match(text(result), /chunk49/);

      assert.match(text(result), /done_reason=stop/);
    } finally {
      await client.close();
    }
  });
});

describe("失敗した要求の回数の制限", () => {
  let ollama: Awaited<ReturnType<typeof startMockOllama>>;

  let server: Awaited<ReturnType<typeof startHttpServer>>;

  before(async () => {
    ollama = await startMockOllama();

    server = await startHttpServer({ OLLAMA_URL: ollama.url, MCP_AUTH_TOKEN: "test-token" });
  });

  after(async () => {
    await server.stop();

    await ollama.close();
  });

  const NOTIFY = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });

  test("成功した要求は数えない", async () => {
    for (let i = 0; i < 80; i += 1) {
      const response = await post(server.url, {
        body: NOTIFY,
        headers: { Authorization: "Bearer test-token" },
      });

      assert.equal(response.status, 202, `request ${i}`);
    }
  });

  test("認証の失敗が 1 分に 60 回を超えると、429 で断る", async () => {
    for (let i = 0; i < 60; i += 1) {
      const response = await post(server.url, { body: INITIALIZE });

      assert.equal(response.status, 401, `request ${i}`);
    }

    const limited = await post(server.url, { body: INITIALIZE });

    assert.equal(limited.status, 429);

    assert.ok(limited.headers.get("retry-after"), "Retry-After is missing");

    const body = (await limited.json()) as { jsonrpc: string; error: { code: number; message: string } };

    assert.equal(body.jsonrpc, "2.0");

    assert.match(body.error.message, /Too many failed requests/);
  });
});
