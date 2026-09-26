import assert from "node:assert/strict";

import { after, before, test } from "node:test";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

// 手元の .env を読ませないため、設定を読み込む前に作業ディレクトリを移す
process.chdir(WORK_DIR);

after(removeCreatedTrees);

const { withIdentity } = await import("../src/audit.ts");

const { JOB_TTL_MS, jobStats, ollamaJob, startJob } = await import("../src/tools/jobs.ts");

// 監査の 1 行は標準エラーに出る。試験の出力を埋めないよう、この間だけ黙らせる
const originalError = console.error;

before(() => {
  console.error = () => {};
});

after(() => {
  console.error = originalError;
});

type Deferred = { resolve: (text: string) => void; reject: (error: Error) => void };

// 終わらせる時を試験が決められる生成
function deferredRun() {
  const handle: Partial<Deferred> & { progress?: (info: { chunks: number; elapsedMs: number; queued?: number }) => void } = {};

  const run = (onProgress: (info: { chunks: number; elapsedMs: number; queued?: number }) => void) => {
    handle.progress = onProgress;

    return new Promise<string>((resolve, reject) => {
      handle.resolve = resolve;

      handle.reject = reject;
    });
  };

  return { handle, run };
}

const text = (result: unknown): string => (typeof result === "string" ? result : (result as { text: string }).text);

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("受け付けたジョブは、待ち、生成中、完了と状態が変わり、結果を返す", async () => {
  const { handle, run } = deferredRun();

  const { id } = withIdentity("alice@example.com", () => startJob({ tool: "ollama_chat", model: "mock", args: {}, run }));

  assert.match(id, /^[0-9a-f-]{36}$/);

  withIdentity("alice@example.com", () => {
    assert.match(text(ollamaJob({ id })), /: queued, \d+ s since accepted\.\nCheck again/);
  });

  handle.progress?.({ chunks: 0, elapsedMs: 0, queued: 2 });

  withIdentity("alice@example.com", () => {
    assert.match(text(ollamaJob({ id })), /queued \(2 ahead\)/);
  });

  handle.progress?.({ chunks: 0, elapsedMs: 0 });

  handle.progress?.({ chunks: 12, elapsedMs: 10000 });

  withIdentity("alice@example.com", () => {
    assert.match(text(ollamaJob({ id })), /running for \d+ s, 12 chunks so far/);
  });

  handle.resolve?.("Saved: C:\\dev\\ollama-out\\x.md");

  await settle();

  withIdentity("alice@example.com", () => {
    const done = text(ollamaJob({ id }));

    assert.match(done, /^Job .* \(ollama_chat, mock\): done in \d+ s\.\nSaved: C:\\dev\\ollama-out\\x\.md$/);
  });
});

test("ほかの識別子のジョブは、あるかどうかも見せない", async () => {
  const { handle, run } = deferredRun();

  const { id } = withIdentity("alice@example.com", () => startJob({ tool: "ollama_chat", model: "mock", args: {}, run }));

  withIdentity("mallory@example.com", () => {
    assert.throws(() => ollamaJob({ id }), /No background job .* for this caller/);

    assert.doesNotMatch(text(ollamaJob({})), new RegExp(id));
  });

  withIdentity("alice@example.com", () => {
    assert.match(text(ollamaJob({})), new RegExp(`${id} {2}ollama_chat {2}mock {2}queued`));
  });

  handle.resolve?.("ok");

  await settle();
});

test("失敗したジョブは理由を返す", async () => {
  const { handle, run } = deferredRun();

  const { id } = withIdentity("bob", () => startJob({ tool: "ollama_review_code", model: "mock", args: {}, run }));

  handle.reject?.(new Error("Ollama returned HTTP 500"));

  await settle();

  withIdentity("bob", () => {
    assert.match(text(ollamaJob({ id })), /failed after \d+ s\.\nError: Ollama returned HTTP 500/);
  });
});

test("終わってから 1 時間を過ぎた記録は消す。生成中のものは消さない", async () => {
  const finished = deferredRun();

  const running = deferredRun();

  const done = withIdentity("carol", () => startJob({ tool: "ollama_chat", model: "mock", args: {}, run: finished.run }));

  const busy = withIdentity("carol", () => startJob({ tool: "ollama_chat", model: "mock", args: {}, run: running.run }));

  finished.handle.resolve?.("ok");

  await settle();

  const later = Date.now() + JOB_TTL_MS + 1000;

  withIdentity("carol", () => {
    assert.throws(() => ollamaJob({ id: done.id }, later), /No background job/);

    assert.match(text(ollamaJob({ id: busy.id }, later)), /queued/);
  });

  running.handle.resolve?.("ok");

  await settle();
});

test("数はどの識別子のものも数える", async () => {
  const { handle, run } = deferredRun();

  const before = jobStats();

  withIdentity("dave", () => startJob({ tool: "ollama_chat", model: "mock", args: {}, run }));

  handle.progress?.({ chunks: 0, elapsedMs: 0 });

  assert.equal(jobStats().running, before.running + 1);

  handle.resolve?.("ok");

  await settle();

  assert.equal(jobStats().running, before.running);

  assert.equal(jobStats().finished, before.finished + 1);
});
