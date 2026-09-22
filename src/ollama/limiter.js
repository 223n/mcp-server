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
export function createLimiter({ max, maxQueue }) {
  let active = 0;

  const queue = [];

  function next() {
    if (active >= max) {
      return;
    }

    const waiter = queue.shift();

    if (!waiter) {
      return;
    }

    waiter.start();
  }

  return {
    stats() {
      return { active, queued: queue.length, max, maxQueue };
    },

    /**
     * 枠が空くまで待ってから fn を動かす。
     * 待ち行列も一杯なら、待たせずにその場で断る。
     */
    async run(fn, { signal, onWait } = {}) {
      if (active >= max) {
        if (queue.length >= maxQueue) {
          throw new Error(
            `Too many generations in flight (${active} running, ${queue.length} queued, limit ${max}+${maxQueue}). Try again in a moment, or raise OLLAMA_MAX_CONCURRENCY.`,
          );
        }

        onWait?.({ active, queued: queue.length + 1 });

        await new Promise((resolve, reject) => {
          const waiter = {
            start: () => {
              signal?.removeEventListener("abort", onAbort);

              resolve();
            },
          };

          function onAbort() {
            const index = queue.indexOf(waiter);

            if (index >= 0) {
              queue.splice(index, 1);
            }

            reject(new Error("Cancelled by the MCP client while queued"));
          }

          signal?.addEventListener("abort", onAbort, { once: true });

          queue.push(waiter);
        });
      }

      active += 1;

      try {
        return await fn();
      } finally {
        active -= 1;

        next();
      }
    },
  };
}
