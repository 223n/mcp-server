import assert from "node:assert/strict";

import type { AddressInfo, Socket } from "node:net";

import { createServer } from "node:net";

import { after, test } from "node:test";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

// 手元の .env を読ませないため、設定を読み込む前に作業ディレクトリを移す
process.chdir(WORK_DIR);

// 接続は受け付けるが、何も返さない Ollama の代わり（固まった Ollama）
const sockets: Socket[] = [];

const hung = createServer((socket) => {
  sockets.push(socket);
});

await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", () => resolve()));

after(async () => {
  sockets.forEach((socket) => socket.destroy());

  await new Promise<void>((resolve) => hung.close(() => resolve()));

  removeCreatedTrees();
});

process.env.OLLAMA_URL = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`;

process.env.OLLAMA_TIMEOUT = "1000";

process.env.OLLAMA_MAX_DURATION = "3000000";

const { ollamaRequest, statusTimeoutMs } = await import("../src/ollama/client.ts");

const { config } = await import("../src/config/config.ts");

test("状態の確認は、効いた上限の値と名前で打ち切りを知らせる", async () => {
  const started = Date.now();

  await assert.rejects(ollamaRequest("/api/version"), (error: Error) => {
    // 以前は、同時に切れる全体の上限が先に発火し、効いていない OLLAMA_MAX_DURATION（3000 秒）を出していた
    assert.match(error.message, /did not finish within 1 s \(OLLAMA_TIMEOUT/);

    assert.doesNotMatch(error.message, /OLLAMA_MAX_DURATION|3000 s/);

    return true;
  });

  assert.ok(Date.now() - started < 5000, "the status request waited too long");
});

test("状態の確認の上限は、OLLAMA_TIMEOUT が長くても 15 秒にとどめる", () => {
  const saved = config.ollamaTimeout;

  try {
    config.ollamaTimeout = 300000;

    assert.equal(statusTimeoutMs(), 15000);

    config.ollamaTimeout = 5000;

    assert.equal(statusTimeoutMs(), 5000);
  } finally {
    config.ollamaTimeout = saved;
  }
});
