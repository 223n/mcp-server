import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";

import express from "express";

import rateLimit from "express-rate-limit";

import { createMcpExpressApp } from "@modelcontextprotocol/express";

import { toNodeHandler } from "@modelcontextprotocol/node";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { initAuditLog, pruneAuditLogs, withIdentity } from "./src/audit.ts";

import { config } from "./src/config/config.ts";

import { createAuthMiddleware } from "./src/http/auth.ts";

import { createServer } from "./src/server.ts";

import { initClone } from "./src/tools/git.ts";

import { initOutput } from "./src/tools/output.ts";

const logError = (error: unknown): void =>
  console.error("[mcp]", error instanceof Error ? error.message : error);

function rpcError(res: Response, status: number, code: number, message: string): void {
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
root.use((req: Request, res: Response, next: NextFunction) => {
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
    const path = (req.originalUrl.split("?")[0] ?? "").slice(0, 100);

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

// 失敗した要求（状態コードが 400 以上）だけを数え、1 分に 60 回を超えた接続元をしばらく断る。
// 認証（JWT の署名の確かめと鍵の取得）は重いため、その手前に置いて、偽のトークンの連打を止める。
// 成功した要求は数えないので、認証を通った普段の利用は妨げない（長い生成は終わるまで一時的に数に入るため、
// 同時に走る生成の数より十分に大きくしておく）。
// 接続元は相手の IP で見分ける。X-Forwarded-For は同じ PC のほかのプロセスが偽れるため信じない。
// Cloudflare Tunnel を通る要求は、どれも cloudflared の IP から届くため、同じ枠を分け合う
const failureLimiter = rateLimit({
  windowMs: 60 * 1000,

  limit: 60,

  skipSuccessfulRequests: true,

  standardHeaders: "draft-7",

  legacyHeaders: false,

  // cloudflared が付ける X-Forwarded-For を、上のとおり意図して使わない。起動のたびの警告を止める
  validate: { xForwardedForHeader: false },

  handler: (_req, res) => rpcError(res, 429, -32000, "Too many failed requests from this client. Try again in a minute."),
});

root.use("/mcp", failureLimiter);

const auth = createAuthMiddleware();

if (auth) {
  // createMcpExpressApp は本文の解析（express.json、上限 4 MB）を先に積んでいる。
  // app に足すとその後ろになり、認証の無い相手の本文まで読み終えてから 401 を返すことになる。
  // root に足して、本文を読む前に断る。Host と Origin の確かめは、認証を通ったものに対して行う
  root.use("/mcp", auth);
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

// 監査ログのファイルの書き出し先を確かめる。古いファイルを消すのは HTTP のプロセスだけにする。
// stdio のプロセスはクライアントごとに起動し直されるため、消す役を持たせるとぶつかる
if (initAuditLog({ warn: (message) => console.warn(message) })) {
  const prune = (): void => {
    try {
      const removed = pruneAuditLogs();

      if (removed.length > 0) {
        console.log(`[audit] removed ${removed.length} audit log file(s) older than ${config.auditRetentionDays} days`);
      }
    } catch (error) {
      console.warn("[audit] could not prune audit logs:", error instanceof Error ? error.message : error);
    }
  };

  prune();

  setInterval(prune, 24 * 60 * 60 * 1000).unref();

  console.log(`[audit] writing audit logs to ${config.auditLogDir} (kept ${config.auditRetentionDays} days)`);
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

app.all("/mcp", (req: Request, res: Response) => {
  if (req.method !== "POST") {
    res.set("Allow", "POST");

    return rpcError(res, 405, -32000, "Method not allowed");
  }

  // express.json が解析しなかった本文を SDK に渡すと、上限なしでメモリに読み込まれるため拒否する
  if (req.body === undefined) {
    return rpcError(res, 415, -32000, "Request body must be JSON (Content-Type: application/json)");
  }

  // 監査に残す識別子を、この呼び出しの間だけ持ち回る。
  // 認証が無い構成では "anonymous" になる
  withIdentity(req.mcpIdentity ?? "anonymous", () => {
    void mcp(req, res, req.body);
  });
});

root.use(app);

const onError: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const failure = err as { type?: string } | undefined;

  if (failure?.type === "entity.parse.failed") {
    return rpcError(res, 400, -32700, "Parse error");
  }

  if (failure?.type === "entity.too.large") {
    return rpcError(res, 413, -32600, "Request body too large");
  }

  logError(err);

  return rpcError(res, 500, -32603, "Internal error");
};

root.use(onError);

const httpServer = root.listen(config.port, config.host, () => {
  console.log(`ollama-mcp listening on http://${config.host}:${config.port}/mcp`);
});

// 要求を受け取り終えるまでの上限。応答を返している時間（生成の時間）には効かない。
// headersTimeout は requestTimeout より短くしておく必要がある
httpServer.requestTimeout = config.httpRequestTimeout;

httpServer.headersTimeout = Math.min(60000, config.httpRequestTimeout - 1000);

console.log(
  `[http] request timeout: ${Math.round(config.httpRequestTimeout / 1000)} s (HTTP_REQUEST_TIMEOUT, receiving the request only)`,
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
