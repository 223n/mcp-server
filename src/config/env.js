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

  // 1 回の生成全体の上限。
  // 14B に大きな入力を渡すと 10 分を超えることがあるため、既定を 3000 秒にしている。
  // 無通信の上限（OLLAMA_TIMEOUT）は 300 秒のままなので、Ollama が固まったときは早く気付ける
  OLLAMA_MAX_DURATION: toInt("OLLAMA_MAX_DURATION", 3000000, 1000, MAX_TIMER_MS),

  // 同時に走らせる生成の数と、待ち行列の長さの上限。
  // Ollama は GPU を 1 つずつ使うため、並べても全体は速くならない
  OLLAMA_MAX_CONCURRENCY: toInt("OLLAMA_MAX_CONCURRENCY", 2, 1, 64),

  OLLAMA_MAX_QUEUE: toInt("OLLAMA_MAX_QUEUE", 8, 0, 1000),

  PORT: toInt("PORT", 3000, 1, 65535),

  HOST: process.env.HOST || "0.0.0.0",

  ALLOWED_HOSTS: toList(
    process.env.ALLOWED_HOSTS ||
      "localhost,127.0.0.1,[::1],host.docker.internal,mcp.223n.tech",
  ),

  // 例: "C:\dev=/work/dev;C:\docker=/work/docker"（ホスト側パス=コンテナ内パス）
  FILE_ROOTS: process.env.FILE_ROOTS || "",

  HTTP_ALLOW_FILES: process.env.HTTP_ALLOW_FILES === "true",

  // ローカルのモデルの出力を書き出す先（ホスト側パス=コンテナー内パス）。1 つだけ。
  // 設定したときだけ save_output が使えるようになる。読み込みの許可ルートとは別に持つ
  OUTPUT_DIR: process.env.OUTPUT_DIR || "",

  // HTTP でも書き出しを許すかどうか。HTTP_ALLOW_FILES とは別に持ち、
  // 読み込みを許しただけの設定が、更新で黙って書き込みに広がらないようにする
  HTTP_ALLOW_WRITES: process.env.HTTP_ALLOW_WRITES === "true",

  // リポジトリを取得する先（ホスト側パス=コンテナー内パス）。1 つだけ。
  // サーバーが書き換えてよいのはここの配下だけで、FILE_ROOTS には書かない
  CLONE_ROOT: process.env.CLONE_ROOT || "",

  // 取得してよい GitHub の owner（カンマ区切り）。空なら取得そのものを拒む
  GIT_ALLOWED_OWNERS: toList(process.env.GIT_ALLOWED_OWNERS || ""),

  // 作業ツリーと履歴を変える操作（commit、push、ブランチの作成）を許すかどうか。
  // 既定は false。HTTP では、この値に関わらず恒久的に使えない
  GIT_ALLOW_WRITE: process.env.GIT_ALLOW_WRITE === "true",

  // GitHub の API に使うトークン。fine-grained を想定する。
  // 名前を GITHUB_TOKEN にしないのは、CI やシェルにたまたま存在することが多く、
  // ホストで直に起動したときに無関係のトークンで GitHub のツールが有効になるため
  GITHUB_MCP_TOKEN: process.env.GITHUB_MCP_TOKEN || "",

  // GitHub 側を変える操作（PR の作成、コメント）を許すかどうか。
  // 既定は false。HTTP では、この値に関わらず恒久的に使えない
  GITHUB_ALLOW_WRITE: process.env.GITHUB_ALLOW_WRITE === "true",

  // git の子プロセスが何も出さない状態の上限と、1 回の操作全体の上限
  GIT_TIMEOUT: toInt("GIT_TIMEOUT", 120000, 1000, MAX_TIMER_MS),

  GIT_MAX_DURATION: toInt("GIT_MAX_DURATION", 600000, 1000, MAX_TIMER_MS),

  // commit に使う名前とメールアドレス
  GIT_USER_NAME: process.env.GIT_USER_NAME || "",

  GIT_USER_EMAIL: process.env.GIT_USER_EMAIL || "",

  // HTTP の認証。どちらかを設定すると、満たさないリクエストは 401 になる
  MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN || "",

  CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || "",

  CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || "",

  // 設定すると、Access の JWT の email がこの一覧にある人だけを通す（カンマ区切り）
  CF_ACCESS_ALLOWED_EMAILS: toList(process.env.CF_ACCESS_ALLOWED_EMAILS || ""),
};
