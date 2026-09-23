import type { AddressInfo } from "node:net";

import type { IncomingMessage, ServerResponse } from "node:http";

import { createServer } from "node:http";

/** /api/chat が受け取った本文。試験が中身を確かめるために残す */
export type MockChat = {
  model?: string;
  messages: { role: string; content: string }[];
  options?: Record<string, unknown>;
};

export type MockState = { chats: MockChat[]; aborted: number };

// 試験用の Ollama の代わり。/api/version、/api/tags、/api/chat（NDJSON のストリーミング）に応答する。
// プロンプトに含まれる語で振る舞いを変える。
//   MOCK_SLOW   200 ミリ秒ごとに 50 回に分けて返す（中断とタイムアウトの試験用）
//   MOCK_ERROR  HTTP 500 とエラーの JSON を返す
// 応答の最初の断片には、受け取ったファイルの数（"### File:" の数）を入れる
export async function startMockOllama() {
  const state: MockState = { chats: [], aborted: 0 };

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/version") {
      return sendJson(res, 200, { version: "0.0.0-mock" });
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

      res.end(
        `${JSON.stringify({ model: body.model, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: count })}\n`,
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

    close: () =>
      new Promise<void>((resolve) => {
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
