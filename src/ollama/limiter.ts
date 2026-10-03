/**
 * 同時に走らせる生成の数を絞る。
 *
 * Ollama は GPU を 1 つずつ使うため、並べて投げても待ち行列に並ぶだけで、
 * 全体は速くならない。待っている間もクライアントの上限（claude.ai は約 240 秒）は
 * 進むので、待たせ続けるより「今は混んでいる」と早く返したほうが判断しやすい。
 *
 * OLLAMA_MAX_DURATION を 3000 秒まで延ばしたことで、詰まった呼び出し 1 件が
 * 長く枠を占めるようになった。ここで枠の数と待ち行列の長さの両方に上限を設ける。
 */

/** 枠を待っている呼び出しに知らせる、いまの位置 */
export type WaitInfo = {
  /** 実行中の生成の数 */
  active: number;

  /** 自分より前に並んでいる数。0 なら、枠が空けば次に動く */
  ahead: number;
};

type Waiter = { start: () => void; onWait?: (info: WaitInfo) => void };

export type LimiterStats = { active: number; queued: number; max: number; maxQueue: number };

export type RunOptions = {
  signal?: AbortSignal;

  /** 並んだときと、前が抜けて位置が進んだときに呼ぶ */
  onWait?: (info: WaitInfo) => void;
};

export function createLimiter({ max, maxQueue }: { max: number; maxQueue: number }) {
  let active = 0;

  const queue: Waiter[] = [];

  // 前が抜けたあと、from から後ろに並んでいる呼び出しに新しい位置を知らせる。
  // ほかの呼び出しの finally や abort の処理の中から呼ぶため、知らせの失敗で列を止めない
  function announce(from: number) {
    for (let index = from; index < queue.length; index += 1) {
      try {
        queue[index]?.onWait?.({ active, ahead: index });
      } catch {
        // 位置の知らせは補助。失敗しても待ち行列は進める
      }
    }
  }

  function next() {
    if (active >= max) {
      return;
    }

    const waiter = queue.shift();

    if (!waiter) {
      return;
    }

    // 枠は、ここで待っていた呼び出しに渡す。active を先に増やしておかないと、
    // 待っていた呼び出しが動き出すまでの間（マイクロタスクの分）に来た新しい呼び出しが、
    // 空いたように見える枠を横取りし、上限を超えて走る
    active += 1;

    waiter.start();

    announce(0);
  }

  return {
    stats(): LimiterStats {
      return { active, queued: queue.length, max, maxQueue };
    },

    /**
     * 枠が空くまで待ってから fn を動かす。
     * 待ち行列も一杯なら、待たせずにその場で断る。
     */
    async run<T>(fn: () => Promise<T> | T, { signal, onWait }: RunOptions = {}): Promise<T> {
      // すでに中断された呼び出しは並ばせない。abort のイベントはもう来ないため、並ぶと
      // 生きている呼び出しの席をふさいだまま残り、順番が来てから中断済みの fn を動かしてしまう
      if (signal?.aborted) {
        throw new Error("Cancelled by the MCP client before it was queued");
      }

      if (active >= max) {
        if (queue.length >= maxQueue) {
          throw new Error(
            `Too many generations in flight (${active} running, ${queue.length} queued, limit ${max}+${maxQueue}). Try again in a moment, or raise OLLAMA_MAX_CONCURRENCY.`,
          );
        }

        // 並ぶ前に知らせる。ここで失敗しても、並んでいないので席をふさがない
        onWait?.({ active, ahead: queue.length });

        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = {
            start: () => {
              signal?.removeEventListener("abort", onAbort);

              resolve();
            },

            onWait,
          };

          function onAbort() {
            const index = queue.indexOf(waiter);

            if (index >= 0) {
              queue.splice(index, 1);

              // 後ろに並んでいた呼び出しは、1 つ前に進む
              announce(index);
            }

            reject(new Error("Cancelled by the MCP client while queued"));
          }

          signal?.addEventListener("abort", onAbort, { once: true });

          queue.push(waiter);
        });

        // 枠は next() が active を増やしてから渡している
      } else {
        active += 1;
      }

      try {
        return await fn();
      } finally {
        active -= 1;

        next();
      }
    },
  };
}
