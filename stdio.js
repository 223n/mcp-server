import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { setDefaultIdentity } from "./src/audit.js";

import { createServer } from "./src/server.js";

import { initClone } from "./src/tools/git.js";

import { initOutput } from "./src/tools/output.js";

// OUTPUT_DIR が使えるかを先に確かめる。stdout は MCP の通信路なので、警告は stderr に出る
const allowWrites = await initOutput();

// git のツールは stdio でだけ書き込みを許す。local: true がその印
await initClone();

// stdout は MCP の通信路なので、ログは必ず stderr（console.error）に出す
// stdio は同じ PC の Claude からの接続なので、監査の識別子は固定でよい
setDefaultIdentity("stdio");

const handle = serveStdio(() => createServer({ allowFiles: true, allowWrites, local: true }), {
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
