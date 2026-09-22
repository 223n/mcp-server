// ホストの Node で直接動かすときのために .env を読む（Docker では compose が環境変数を渡すため .env は無い）。
// Node 標準の process.loadEnvFile は、すでにある環境変数を上書きせず、標準出力にも何も書かない
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

// 不正な値は起動時にエラーにする（"5m" や "3e5" を黙って 5 や 3 と解釈しない）
function toInt(name, fallback, min, max) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }

  const n = Number(raw);

  if (n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  }

  return n;
}

function toList(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const MAX_TIMER_MS = 2147483647;

export const env = {
  OLLAMA_URL: process.env.OLLAMA_URL || "http://host.docker.internal:11434",

  DEFAULT_MODEL: process.env.DEFAULT_MODEL || "nucbox-fast:latest",

  DEEP_MODEL: process.env.DEEP_MODEL || "qwen2.5-coder:14b",

  // Ollama から何も届かない状態の上限。キュー待ち、モデル読み込み、プロンプト評価の時間も含む
  OLLAMA_TIMEOUT: toInt("OLLAMA_TIMEOUT", 300000, 1000, MAX_TIMER_MS),

  // 1 回の生成全体の上限
  OLLAMA_MAX_DURATION: toInt("OLLAMA_MAX_DURATION", 900000, 1000, MAX_TIMER_MS),

  PORT: toInt("PORT", 3000, 1, 65535),

  HOST: process.env.HOST || "0.0.0.0",

  ALLOWED_HOSTS: toList(
    process.env.ALLOWED_HOSTS ||
      "localhost,127.0.0.1,[::1],host.docker.internal,mcp.223n.tech",
  ),

  // 例: "C:\dev=/work/dev;C:\docker=/work/docker"（ホスト側パス=コンテナ内パス）
  FILE_ROOTS: process.env.FILE_ROOTS || "",

  HTTP_ALLOW_FILES: process.env.HTTP_ALLOW_FILES === "true",

  // HTTP の認証。どちらかを設定すると、満たさないリクエストは 401 になる
  MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN || "",

  CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || "",

  CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || "",
};
