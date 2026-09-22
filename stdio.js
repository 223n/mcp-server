import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createServer } from "./src/server.js";

// stdout は MCP の通信路なので、ログは必ず stderr（console.error）に出す
const handle = serveStdio(() => createServer({ allowFiles: true }), {
  onerror: (error) => console.error("[mcp]", error?.message ?? error),
});

// クライアントが終了して stdin が閉じたら、処理中の Ollama 呼び出しも中断して終了する。
// これがないと、残ったプロセスが生成を続けて GPU を占有してしまう
let stopping = false;

function stop() {
  if (stopping) {
    return;
  }

  stopping = true;

  handle
    .close()
    .catch(() => {})
    .finally(() => process.exit(0));
}

process.stdin.once("end", stop);

process.stdin.once("close", stop);

process.once("SIGTERM", stop);

process.once("SIGINT", stop);
