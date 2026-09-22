import express from "express";

import { createMcpExpressApp } from "@modelcontextprotocol/express";

import { toNodeHandler } from "@modelcontextprotocol/node";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { config } from "./src/config/config.js";

import { createAuthMiddleware } from "./src/http/auth.js";

import { createServer } from "./src/server.js";

import { initClone } from "./src/tools/git.js";

import { initOutput } from "./src/tools/output.js";

const logError = (error) => console.error("[mcp]", error?.message ?? error);

function rpcError(res, status, code, message) {
  res.status(status).json({
    jsonrpc: "2.0",

    error: {
      code,

      message,
    },

    id: null,
  });
}

const root = express();

// Docker の healthcheck 用。Host 検証やアクセスログより前に置く
root.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// アクセスログ。オリジンまでリクエストが届いているかの確認に使う。
// 本文は記録せず、JSON-RPC のメソッド名だけを安全な文字に限って出す。
// Host 検証で 403 になったリクエストや、途中で切断されたリクエストも記録する
root.use((req, res, next) => {
  const started = Date.now();

  res.on("close", () => {
    const method = req.body?.method;

    const rpc =
      typeof method === "string" && /^[\w/.-]{1,64}$/.test(method)
        ? method
        : Array.isArray(req.body)
          ? "batch"
          : "-";

    const host = String(req.headers.host ?? "-")
      .replace(/[^\w.:[\]-]/g, "?")
      .slice(0, 100);

    const status = res.writableFinished ? res.statusCode : "aborted";

    // app.use("/mcp", ...) の中で応答すると req.path はマウント位置を除いた値になるため、originalUrl を使う
    const path = req.originalUrl.split("?")[0].slice(0, 100);

    console.log(
      `${new Date().toISOString()} ${req.method} ${path} ${status} ${Date.now() - started}ms host=${host} rpc=${rpc}`,
    );
  });

  next();
});

// Host / Origin を検証して DNS rebinding を防ぐ（許可外は 403）
const app = createMcpExpressApp({
  host: config.host,

  allowedHosts: config.allowedHosts,

  allowedOrigins: config.allowedHosts,

  jsonLimit: "4mb",
});

const auth = createAuthMiddleware();

if (auth) {
  app.use("/mcp", auth);
} else {
  console.warn(
    "[auth] HTTP /mcp has no authentication. Set MCP_AUTH_TOKEN or CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD to require it.",
  );
}

if (config.cfAccessTeamDomain && config.cfAccessAud) {
  // 設定がコンテナーに届いているかを確かめられるよう、件数だけを出す（アドレスは出さない）
  console.log(
    config.cfAccessAllowedEmails.length > 0
      ? `[auth] Cloudflare Access JWT required; CF_ACCESS_ALLOWED_EMAILS has ${config.cfAccessAllowedEmails.length} address(es)`
      : "[auth] Cloudflare Access JWT required; any identity the Access policy admits is accepted (CF_ACCESS_ALLOWED_EMAILS is empty)",
  );
}

if (config.httpAllowFilesRequested && !config.httpAllowFiles) {
  console.warn(
    "[files] HTTP_ALLOW_FILES=true is ignored because HTTP has no authentication. File tools stay disabled over HTTP.",
  );
} else if (config.httpAllowFiles && config.fileRoots.length === 0) {
  console.warn("[files] HTTP_ALLOW_FILES=true but FILE_ROOTS is empty, so there are no file tools.");
} else if (config.httpAllowFiles) {
  console.warn("[files] File tools are enabled over HTTP (authenticated requests only).");
}

// 2026-07-28 版（server/discover）と 2025 年版（initialize）の両方にステートレスで応答する。
// responseMode "sse" で結果を待つ間もキープアライブを流し、Cloudflare の 100 秒制限を避ける
// OUTPUT_DIR が実在して書けるかを起動時に確かめる。使えなければ保存のツールを出さない
const outputUsable = await initOutput({ warn: (message) => console.warn(message) });

const allowWrites = config.httpAllowWrites && outputUsable;

if (config.httpAllowWritesRequested && !config.httpAllowWrites) {
  console.warn(
    "[output] HTTP_ALLOW_WRITES=true is ignored because HTTP has no authentication. Saving stays disabled over HTTP.",
  );
} else if (allowWrites) {
  console.warn("[output] Saving model output to files is enabled over HTTP (authenticated requests only).");
}

// git のツールも同じように起動時に確かめる。
// HTTP では local: false のため、書き込み系（git_write、github_write）は登録されない
await initClone({ warn: (message) => console.warn(message) });

if (config.gitAllowWrite || config.githubAllowWrite) {
  console.warn(
    "[git] GIT_ALLOW_WRITE / GITHUB_ALLOW_WRITE only take effect over stdio. HTTP never gets the write tools.",
  );
}

const handler = createMcpHandler(
  () => createServer({ allowFiles: config.httpAllowFiles, allowWrites, local: false }),

  {
    legacy: "stateless",

    responseMode: "sse",

    onerror: logError,
  },
);

const mcp = toNodeHandler(handler, { onerror: logError });

app.all("/mcp", (req, res) => {
  if (req.method !== "POST") {
    res.set("Allow", "POST");

    return rpcError(res, 405, -32000, "Method not allowed");
  }

  // express.json が解析しなかった本文を SDK に渡すと、上限なしでメモリに読み込まれるため拒否する
  if (req.body === undefined) {
    return rpcError(res, 415, -32000, "Request body must be JSON (Content-Type: application/json)");
  }

  void mcp(req, res, req.body);
});

root.use(app);

root.use((err, _req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err?.type === "entity.parse.failed") {
    return rpcError(res, 400, -32700, "Parse error");
  }

  if (err?.type === "entity.too.large") {
    return rpcError(res, 413, -32600, "Request body too large");
  }

  logError(err);

  return rpcError(res, 500, -32603, "Internal error");
});

const httpServer = root.listen(config.port, config.host, () => {
  console.log(`ollama-mcp listening on http://${config.host}:${config.port}/mcp`);
});

// Node の既定（300 秒）のままだと、長い生成が 408 で切られる。
// headersTimeout は requestTimeout より短くしておく必要がある
httpServer.requestTimeout = config.httpRequestTimeout;

httpServer.headersTimeout = Math.min(60000, config.httpRequestTimeout - 1000);

console.log(
  `[http] request timeout: ${Math.round(config.httpRequestTimeout / 1000)} s (OLLAMA_MAX_DURATION + 60 s)`,
);

let stopping = false;

async function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;

  setTimeout(() => process.exit(0), 5000).unref();

  await handler.close().catch(logError);

  httpServer.close(() => process.exit(0));

  // 2025 年版の処理中リクエストは接続を閉じたときに中断される
  httpServer.closeAllConnections();
}

process.once("SIGTERM", shutdown);

process.once("SIGINT", shutdown);
