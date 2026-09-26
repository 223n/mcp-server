import type { Root } from "../types.ts";

import { env } from "./env.ts";

function toUnixPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

// "C:\dev=/work/dev;C:\docker=/work/docker" → [{ hostPrefix: "c:/dev", localPath: "/work/dev" }, ...]
// "=" を省略した場合はホスト側パスをそのまま使う（ホストの Node で直接動かす場合）
function parseFileRoots(value: string): Root[] {
  return value
    .split(";")
    .map((entry: string) => entry.trim())
    .filter(Boolean)
    .map((entry: string): Root => {
      const [rawHost, rawLocal] = entry.split("=");

      // filter(Boolean) を通っているため空文字にはならないが、型の上では undefined になりうる
      const hostPath = rawHost ?? "";

      const localPath = rawLocal ?? hostPath;

      return {
        hostPrefix: toUnixPath(hostPath).toLowerCase(),
        hostLabel: hostPath.trim(),
        localPath: toUnixPath(localPath),
      };
    });
}

// 書き込み先のルートは 1 件だけ。"=" を 2 つ以上書いたものや ";" で並べたものは、
// 意図した場所と違うところへ書く事故になるため受け取らない
function parseSingleRoot(value: string, name: string): Root | null {
  const entry = value.trim();

  if (!entry) {
    return null;
  }

  if (entry.includes(";") || entry.split("=").length > 2) {
    throw new Error(`${name} must be a single "hostPath=containerPath" entry`);
  }

  const [rawHost, rawLocal] = entry.split("=");

  const hostPath = rawHost ?? "";

  const local = toUnixPath(rawLocal ?? hostPath);

  if (!local || local === "") {
    throw new Error(`${name} must not be empty or the filesystem root`);
  }

  return {
    hostPrefix: toUnixPath(hostPath).toLowerCase(),
    hostLabel: hostPath.trim(),
    localPath: local,
  };
}

const cfAccessTeamDomain = env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");

// HTTP に認証がかかっているか。ファイルの読み込みを HTTP で許すかどうかの判断に使う
const httpAuthConfigured = Boolean(env.MCP_AUTH_TOKEN || (cfAccessTeamDomain && env.CF_ACCESS_AUD));

export const config = {
  ollamaUrl: env.OLLAMA_URL,

  defaultModel: env.DEFAULT_MODEL,

  deepModel: env.DEEP_MODEL,

  ollamaTimeout: env.OLLAMA_TIMEOUT,

  ollamaMaxDuration: env.OLLAMA_MAX_DURATION,

  ollamaMaxConcurrency: env.OLLAMA_MAX_CONCURRENCY,

  ollamaMaxQueue: env.OLLAMA_MAX_QUEUE,

  // Node の requestTimeout は「要求を受け取り終えるまで」の上限で、応答を返している時間には効かない。
  // 以前は OLLAMA_MAX_DURATION + 60 秒（既定で 3060 秒）にしていたが、長い生成を守る効果は無く、
  // 本文をゆっくり送る相手に接続を約 51 分つかませる余地だけを作っていた
  httpRequestTimeout: env.HTTP_REQUEST_TIMEOUT,

  port: env.PORT,

  host: env.HOST,

  allowedHosts: env.ALLOWED_HOSTS,

  fileRoots: parseFileRoots(env.FILE_ROOTS),

  httpAuthConfigured,

  // HTTP でのファイルの読み込みは、認証がかかっているときだけ有効にする
  httpAllowFilesRequested: env.HTTP_ALLOW_FILES,

  httpAllowFiles: env.HTTP_ALLOW_FILES && httpAuthConfigured,

  outputDir: parseSingleRoot(env.OUTPUT_DIR, "OUTPUT_DIR"),

  cloneRoot: parseSingleRoot(env.CLONE_ROOT, "CLONE_ROOT"),

  gitAllowedOwners: env.GIT_ALLOWED_OWNERS.map((owner: string) => owner.toLowerCase()),

  gitAllowWrite: env.GIT_ALLOW_WRITE,

  gitTimeout: env.GIT_TIMEOUT,

  gitMaxDuration: env.GIT_MAX_DURATION,

  gitUserName: env.GIT_USER_NAME,

  gitUserEmail: env.GIT_USER_EMAIL,

  githubToken: env.GITHUB_MCP_TOKEN,

  githubAllowWrite: env.GITHUB_ALLOW_WRITE,

  // 書き出しは読み込みとは別の条件にする。HTTP_ALLOW_FILES=true だけでは書けない
  httpAllowWritesRequested: env.HTTP_ALLOW_WRITES,

  httpAllowWrites: env.HTTP_ALLOW_WRITES && httpAuthConfigured,

  mcpAuthToken: env.MCP_AUTH_TOKEN,

  cfAccessTeamDomain,

  cfAccessAud: env.CF_ACCESS_AUD,

  cfAccessAllowedEmails: env.CF_ACCESS_ALLOWED_EMAILS.map((email: string) => email.toLowerCase()),
};
