import type { AddressInfo } from "node:net";

import type { IncomingMessage, ServerResponse } from "node:http";

import { createServer } from "node:http";

/** /api/chat が受け取った本文。試験が中身を確かめるために残す */
export type MockChat = {
  model?: string;
  messages: { role: string; content: string }[];
  options?: Record<string, unknown>;
  format?: unknown;
};

export type MockState = { chats: MockChat[]; aborted: number };

// 試験用の Ollama の代わり。/api/version、/api/tags、/api/chat（NDJSON のストリーミング）に応答する。
// プロンプトに含まれる語で振る舞いを変える。
//   MOCK_SLOW   200 ミリ秒ごとに 50 回に分けて返す（中断とタイムアウトの試験用）
//   MOCK_ERROR  HTTP 500 とエラーの JSON を返す
// モデルの名前が "missing:model" なら、入っていないモデルとして HTTP 404 を返す
//   MOCK_FULL_CONTEXT  prompt_eval_count を num_ctx（無ければ 32768）ちょうどにする（上限に張り付いた警告の試験用）
//   MOCK_JSON:<文字列>  その行の残りを、そのままモデルの出力として 1 回で返す（構造化したレビューの試験用）
//   MOCK_HOLD:<名前>  試験が release(名前) を呼ぶまで応答を止め、そのあと普通に返す（待ち行列の試験用）
// 応答の最初の断片には、受け取ったファイルの数（"### File:" の数）を入れる
export async function startMockOllama() {
  const state: MockState = { chats: [], aborted: 0 };

  // MOCK_HOLD で止めている応答。名前ごとに、続きを許す関数を持つ
  const held = new Map<string, () => void>();

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/version") {
      return sendJson(res, 200, { version: "0.0.0-mock" });
    }

    if (req.method === "GET" && req.url === "/api/ps") {
      return sendJson(res, 200, {
        models: [
          {
            name: "mock:latest",

            size_vram: 1024 ** 3,

            context_length: 8192,

            expires_at: "2026-09-26T13:00:00Z",
          },
        ],
      });
    }

    if (req.method === "GET" && req.url === "/api/tags") {
      return sendJson(res, 200, {
        models: [
          {
            name: "mock:latest",

            details: {
              parameter_size: "1B",

              quantization_level: "Q4_K_M",

              context_length: 32768,

              family: "mock",
            },
          },
        ],
      });
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      const body = JSON.parse(await readBody(req)) as MockChat;

      state.chats.push(body);

      const prompt = body.messages.at(-1)?.content ?? "";

      if (prompt.includes("MOCK_ERROR")) {
        return sendJson(res, 500, { error: "mock failure" });
      }

      if (body.model === "missing:model") {
        return sendJson(res, 404, { error: 'model "missing:model" not found, try pulling it first' });
      }

      // 試験が決めた出力をそのまま返す
      const fixed = /MOCK_JSON:(.*)$/m.exec(prompt)?.[1];

      if (fixed !== undefined) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });

        res.write(`${JSON.stringify({ message: { role: "assistant", content: fixed }, done: false })}\n`);

        res.end(
          `${JSON.stringify({ model: body.model, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 1 })}\n`,
        );

        return;
      }

      const hold = /MOCK_HOLD:(\w+)/.exec(prompt)?.[1];

      if (hold !== undefined) {
        await new Promise<void>((resolve) => held.set(hold, resolve));

        // 止めている間に呼び出し側が切れていたら、書かずに終える
        if (res.destroyed) {
          return;
        }
      }

      const slow = prompt.includes("MOCK_SLOW");

      const count = slow ? 50 : 3;

      res.writeHead(200, { "Content-Type": "application/x-ndjson" });

      res.on("close", () => {
        if (!res.writableFinished) {
          state.aborted += 1;
        }
      });

      const files = prompt.split("### File:").length - 1;

      for (let i = 0; i < count; i += 1) {
        if (res.destroyed) {
          return;
        }

        const content = i === 0 ? `FILES=${files} chunk${i} ` : `chunk${i} `;

        res.write(`${JSON.stringify({ message: { role: "assistant", content }, done: false })}\n`);

        if (slow) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // 上限に張り付いたときの警告を試すため、求められれば num_ctx ちょうどを返す
      const numCtx = typeof body.options?.num_ctx === "number" ? body.options.num_ctx : 32768;

      const promptEvalCount = prompt.includes("MOCK_FULL_CONTEXT") ? numCtx : 10;

      res.end(
        `${JSON.stringify({ model: body.model, done: true, done_reason: "stop", prompt_eval_count: promptEvalCount, eval_count: count })}\n`,
      );

      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,

    state,

    /** MOCK_HOLD:<name> で止めた応答があれば続けさせ、続けたかどうかを返す */
    release: (name: string): boolean => {
      const resume = held.get(name);

      held.delete(name);

      resume?.();

      return resume !== undefined;
    },

    close: () =>
      new Promise<void>((resolve) => {
        // 止めたままの応答を残すと、接続が閉じきらない
        for (const resume of held.values()) {
          resume();
        }

        held.clear();

        server.closeAllConnections();

        server.close(() => resolve());
      }),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });

  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";

  for await (const chunk of req) {
    body += chunk;
  }

  return body;
}
