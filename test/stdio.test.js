import assert from "node:assert/strict";

import { spawn } from "node:child_process";

import { tmpdir } from "node:os";

import path from "node:path";

import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/client";

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { startMockOllama } from "./helpers/mock-ollama.js";

import { cleanEnv, createFileTree, ROOT, text } from "./helpers/server.js";

process.chdir(tmpdir());

describe("stdio", () => {
  let ollama;

  let root;

  let env;

  before(async () => {
    ollama = await startMockOllama();

    root = createFileTree();

    env = { ...cleanEnv(), OLLAMA_URL: ollama.url, FILE_ROOTS: root };
  });

  after(() => ollama.close());

  for (const mode of ["legacy", "auto"]) {
    test(`${mode}: ファイルのツールを含めて使える`, async () => {
      const client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode } });

      await client.connect(
        new StdioClientTransport({
          command: process.execPath,

          args: [path.join(ROOT, "stdio.js")],

          cwd: tmpdir(),

          env,

          stderr: "ignore",
        }),
      );

      try {
        const { tools } = await client.listTools();

        assert.equal(tools.length, 6);

        const listing = await client.callTool({
          name: "list_files",

          arguments: { path: path.join(root, "app"), pattern: "**/*.php" },
        });

        assert.match(text(listing), /Main\.php/);

        const result = await client.callTool({
          name: "ollama_review_code",

          arguments: { files: [path.join(root, "app", "src", "Main.php")] },
        });

        assert.match(text(result), /FILES=1/);
      } finally {
        await client.close();
      }
    });
  }

  test("stdin が閉じると、処理中の Ollama の呼び出しを止めて終わる", async () => {
    const before = ollama.state.aborted;

    const child = spawn(process.execPath, [path.join(ROOT, "stdio.js")], {
      cwd: tmpdir(),

      env,

      stdio: ["pipe", "pipe", "ignore"],
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    send({
      jsonrpc: "2.0",

      id: 1,

      method: "initialize",

      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({
      jsonrpc: "2.0",

      id: 2,

      method: "tools/call",

      params: { name: "ollama_chat", arguments: { prompt: "MOCK_SLOW" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    const exited = new Promise((resolve) => child.once("exit", resolve));

    child.stdin.end();

    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))]);

    assert.equal(code, 0);

    const deadline = Date.now() + 5000;

    while (ollama.state.aborted === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(ollama.state.aborted > before, "mock Ollama did not see the request aborted");
  });
});
