import assert from "node:assert/strict";

import { after, test } from "node:test";

import type { WaitInfo } from "../src/ollama/limiter.ts";

import { removeCreatedTrees, WORK_DIR } from "./helpers/server.ts";

process.chdir(WORK_DIR);

after(removeCreatedTrees);

const { createLimiter } = await import("../src/ollama/limiter.ts");

// 外から解決できる約束。走り始めたことと、終わらせることを試験から操る
type Deferred = {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
};

function deferred(): Deferred {
  // Promise のコンストラクターは同期で実行されるため、返る時点では必ず入っている
  let resolve!: (value: string) => void;

  let reject!: (reason?: unknown) => void;

  const promise = new Promise<string>((res, rej) => {
    resolve = res;

    reject = rej;
  });

  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("上限までは同時に走らせる", async () => {
  const limiter = createLimiter({ max: 2, maxQueue: 8 });

  const gates = [deferred(), deferred()];

  const runs = gates.map((gate) => limiter.run(() => gate.promise));

  await tick();

  assert.deepEqual(limiter.stats(), { active: 2, queued: 0, max: 2, maxQueue: 8 });

  gates.forEach((gate) => gate.resolve("done"));

  assert.deepEqual(await Promise.all(runs), ["done", "done"]);

  assert.equal(limiter.stats().active, 0);
});

test("上限を超えた分は待ち行列に並ぶ", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 8 });

  const first = deferred();

  let secondStarted = false;

  const running = limiter.run(() => first.promise);

  const waiting = limiter.run(async () => {
    secondStarted = true;

    return "second";
  });

  await tick();

  assert.equal(secondStarted, false, "枠が空く前に走り出している");

  assert.deepEqual(limiter.stats(), { active: 1, queued: 1, max: 1, maxQueue: 8 });

  first.resolve("first");

  assert.equal(await running, "first");

  assert.equal(await waiting, "second");

  assert.equal(secondStarted, true);
});

test("待たせるときは、その旨を知らせる", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 8 });

  const gate = deferred();

  const running = limiter.run(() => gate.promise);

  const waits: WaitInfo[] = [];

  const waiting = limiter.run(async () => "ok", { onWait: (info) => waits.push(info) });

  await tick();

  // 前に並んでいるのは 0 件（次に動く）。自分は数えない
  assert.deepEqual(waits, [{ active: 1, ahead: 0 }]);

  gate.resolve("x");

  await running;

  await waiting;
});

test("前が抜けるたびに、後ろに並んだ呼び出しへ新しい位置を知らせる", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 8 });

  const gates = [deferred(), deferred(), deferred(), deferred()];

  const [gateR, gate1, gate2, gate3] = gates as [Deferred, Deferred, Deferred, Deferred];

  const running = limiter.run(() => gateR.promise);

  const aheads: number[][] = [[], [], []];

  const waiting = [gate1, gate2, gate3].map((gate, index) =>
    limiter.run(() => gate.promise, { onWait: ({ ahead }) => aheads[index]?.push(ahead) }),
  );

  await tick();

  assert.deepEqual(aheads, [[0], [1], [2]]);

  // 実行中のものが終わると、先頭が動き出し、残りは 1 つずつ前に進む。動き出したものには知らせない
  gateR.resolve("r");

  assert.equal(await running, "r");

  await tick();

  assert.deepEqual(aheads, [[0], [1, 0], [2, 1]]);

  gate1.resolve("1");

  await tick();

  assert.deepEqual(aheads, [[0], [1, 0], [2, 1, 0]]);

  gate2.resolve("2");

  gate3.resolve("3");

  assert.deepEqual(await Promise.all(waiting), ["1", "2", "3"]);

  assert.deepEqual(aheads, [[0], [1, 0], [2, 1, 0]]);
});

test("待っている間に中断されたら、その後ろに並んだ呼び出しだけが前に進む", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 8 });

  const gate = deferred();

  const running = limiter.run(() => gate.promise);

  const controller = new AbortController();

  const aheads: number[][] = [[], [], []];

  const first = limiter.run(async () => "first", { onWait: ({ ahead }) => aheads[0]?.push(ahead) });

  const middle = limiter.run(async () => "middle", {
    signal: controller.signal,

    onWait: ({ ahead }) => aheads[1]?.push(ahead),
  });

  const last = limiter.run(async () => "last", { onWait: ({ ahead }) => aheads[2]?.push(ahead) });

  await tick();

  controller.abort();

  await assert.rejects(middle, /Cancelled by the MCP client while queued/);

  assert.deepEqual(aheads, [[0], [1], [2, 1]]);

  gate.resolve("x");

  await running;

  assert.deepEqual(await Promise.all([first, last]), ["first", "last"]);
});

test("位置の知らせが失敗しても、枠を返した呼び出しは成功し、待ち行列は進む", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 8 });

  const gate = deferred();

  const running = limiter.run(() => gate.promise);

  const first = limiter.run(async () => "first");

  let calls = 0;

  // 並んだときの知らせは受け、前に進んだときの知らせで失敗する
  const second = limiter.run(async () => "second", {
    onWait: () => {
      calls += 1;

      if (calls > 1) {
        throw new Error("notify failed");
      }
    },
  });

  await tick();

  gate.resolve("r");

  assert.equal(await running, "r");

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);

  assert.equal(calls, 2);
});

test("待ち行列も一杯なら、待たせずに断る", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 1 });

  const gate = deferred();

  const running = limiter.run(() => gate.promise);

  const queued = limiter.run(async () => "queued");

  await tick();

  await assert.rejects(limiter.run(async () => "third"), /Too many generations in flight/);

  gate.resolve("x");

  await running;

  await queued;
});

test("待っている間に中断されたら、待ち行列から外す", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 8 });

  const gate = deferred();

  const running = limiter.run(() => gate.promise);

  const controller = new AbortController();

  const waiting = limiter.run(async () => "never", { signal: controller.signal });

  await tick();

  assert.equal(limiter.stats().queued, 1);

  controller.abort();

  await assert.rejects(waiting, /Cancelled by the MCP client while queued/);

  assert.equal(limiter.stats().queued, 0);

  gate.resolve("x");

  await running;
});

test("失敗しても枠を返す", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 8 });

  await assert.rejects(
    limiter.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(limiter.stats().active, 0);

  assert.equal(await limiter.run(async () => "next"), "next");
});

test("待ち行列を 0 にすると、上限を超えた時点で断る", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 0 });

  const gate = deferred();

  const running = limiter.run(() => gate.promise);

  await tick();

  await assert.rejects(limiter.run(async () => "x"), /Too many generations in flight/);

  gate.resolve("x");

  await running;
});

test("すでに中断された呼び出しは、並ばせずに断る", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 1 });

  const gate = deferred();

  const first = limiter.run(() => gate.promise);

  const aborted = new AbortController();

  aborted.abort();

  let deadRan = false;

  await assert.rejects(
    limiter.run(
      async () => {
        deadRan = true;

        return "dead";
      },
      { signal: aborted.signal },
    ),
    /Cancelled by the MCP client/,
  );

  // 待ち行列の席をふさがないので、生きている呼び出しは並べる
  assert.equal(limiter.stats().queued, 0);

  const live = limiter.run(async () => "live");

  await tick();

  assert.equal(limiter.stats().queued, 1);

  gate.resolve("done");

  assert.equal(await first, "done");

  assert.equal(await live, "live");

  assert.equal(deadRan, false);
});

// 枠を待っていた呼び出しに渡してから、それが動き出すまでの間に新しい呼び出しが来ても、
// 上限を超えて走らないこと。割り込みの位置はマイクロタスクの深さで変わるため、深さを変えて試す
test("枠を渡した直後に来た呼び出しは、上限を超えて走らない", async () => {
  for (let depth = 0; depth <= 6; depth += 1) {
    const limiter = createLimiter({ max: 1, maxQueue: 8 });

    let running = 0;

    let peak = 0;

    const work = (gate: Deferred) => async () => {
      running += 1;

      peak = Math.max(peak, running);

      try {
        return await gate.promise;
      } finally {
        running -= 1;
      }
    };

    const gates = [deferred(), deferred(), deferred()];

    const [gateA, gateB, gateC] = gates as [Deferred, Deferred, Deferred];

    const runs = [limiter.run(work(gateA)), limiter.run(work(gateB))];

    await tick();

    gateA.resolve("a");

    const late = new Promise<string>((resolve, reject) => {
      const arrive = (remaining: number): void => {
        if (remaining === 0) {
          limiter.run(work(gateC)).then(resolve, reject);
        } else {
          queueMicrotask(() => arrive(remaining - 1));
        }
      };

      arrive(depth);
    });

    await tick();

    assert.ok(limiter.stats().active <= 1, `depth ${depth}: active ${limiter.stats().active}`);

    gateB.resolve("b");

    gateC.resolve("c");

    assert.deepEqual(await Promise.all([...runs, late]), ["a", "b", "c"]);

    assert.equal(peak, 1, `depth ${depth}: ${peak} ran at once`);
  }
});
