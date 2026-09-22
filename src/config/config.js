import { env } from "./env.js";

function toUnixPath(p) {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

// "C:\dev=/work/dev;C:\docker=/work/docker" → [{ hostPrefix: "c:/dev", localPath: "/work/dev" }, ...]
// "=" を省略した場合はホスト側パスをそのまま使う（ホストの Node で直接動かす場合）
function parseFileRoots(value) {
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hostPath, localPath = hostPath] = entry.split("=");

      return {
        hostPrefix: toUnixPath(hostPath).toLowerCase(),
        hostLabel: hostPath.trim(),
        localPath: toUnixPath(localPath),
      };
    });
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

  port: env.PORT,

  host: env.HOST,

  allowedHosts: env.ALLOWED_HOSTS,

  fileRoots: parseFileRoots(env.FILE_ROOTS),

  httpAuthConfigured,

  // HTTP でのファイルの読み込みは、認証がかかっているときだけ有効にする
  httpAllowFilesRequested: env.HTTP_ALLOW_FILES,

  httpAllowFiles: env.HTTP_ALLOW_FILES && httpAuthConfigured,

  mcpAuthToken: env.MCP_AUTH_TOKEN,

  cfAccessTeamDomain,

  cfAccessAud: env.CF_ACCESS_AUD,

  cfAccessAllowedEmails: env.CF_ACCESS_ALLOWED_EMAILS.map((email) => email.toLowerCase()),
};
