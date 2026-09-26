import { spawn } from "node:child_process";

import { config } from "../config/config.ts";

// 応答に載せる出力の上限。git log や git diff は簡単に数MBになる
const MAX_OUTPUT_CHARS = 60000;

/** git の子プロセスに足す環境変数 */
export type GitEnv = Record<string, string>;

/** コマンドの側で渡す git の設定（鍵と値） */
export type GitConfigEntry = [key: string, value: string];

/** runGit の結果。code は、シグナルで終わったときだけ null になる */
export type GitResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

export type GitOptions = {
  cwd?: string;
  env?: GitEnv;

  /** コマンドの側で足す設定。HARDENED_CONFIG の後ろに並べる */
  config?: GitConfigEntry[];

  signal?: AbortSignal;
  onProgress?: (info: { elapsedMs: number }) => void;
};

/**
 * どの git の呼び出しにも、コマンドの側の設定として渡すもの。
 *
 * GIT_CONFIG_SYSTEM と GIT_CONFIG_GLOBAL が差し替えるのはシステムとグローバルの設定だけで、
 * 取得したリポジトリの .git/config（local）はそのまま読まれます。
 * コマンドの側の設定（GIT_CONFIG_COUNT）は local より後に読まれて勝つため、ここで打ち消します。
 *
 * - core.hooksPath、core.fsmonitor: status、diff、commit、push のたびにコマンドを実行させる
 * - credential.helper: 空にすると、それまでに読んだ一覧を捨てる
 * - commit.gpgSign: gpg.program のコマンドを実行させる
 * - protocol.*: システムの設定の protocol.allow より、local の protocol.<名前>.allow が優先される
 *
 * diff.external と、名前を列挙できない鍵（filter.<名前>.clean など）はここでは打ち消せません。
 * 前者は --no-ext-diff で止め、両方とも git.ts が .git/config の鍵を許可リストで確かめて止めます。
 */
const HARDENED_CONFIG: GitConfigEntry[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["credential.helper", ""],
  ["commit.gpgSign", "false"],
  ["protocol.allow", "never"],
  ["protocol.https.allow", "always"],
  ["protocol.http.allow", "never"],
  ["protocol.ssh.allow", "never"],
  ["protocol.git.allow", "never"],
  ["protocol.file.allow", "never"],
  ["protocol.ext.allow", "never"],
];

// 設定を GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n の形にする。
// -c key=value を argv に置く方法と違い、ps から見えず、値が設定の構文として読まれることもない
function configEnv(entries: GitConfigEntry[]): GitEnv {
  const env: GitEnv = { GIT_CONFIG_COUNT: String(entries.length) };

  for (const [index, [key, value]] of entries.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;

    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }

  return env;
}

/**
 * git の子プロセスに渡す環境変数。
 *
 * 継承しないことが防御の本体です。
 * GIT_SSH_COMMAND、GIT_EXTERNAL_DIFF、GIT_PROXY_COMMAND、GIT_ALTERNATE_OBJECT_DIRECTORIES、
 * LD_PRELOAD は、どれも任意のコマンドを実行させる経路になります。
 *
 * GIT_CONFIG_SYSTEM でサーバーが用意した 1 枚だけを読ませ、/etc/gitconfig と利用者のグローバル設定を効かせません。
 * 取得したリポジトリの .git/config は読まれるため、HARDENED_CONFIG を最後に重ねます。
 * 呼び出し側の env が GIT_CONFIG_COUNT を上書きできないよう、設定は env より後ろに置きます。
 */
function childEnv(extra: GitEnv = {}, config: GitConfigEntry[] = []): GitEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/local/bin",

    HOME: "/tmp/git-home",

    LANG: "C.UTF-8",

    NO_COLOR: "1",

    GIT_CONFIG_SYSTEM: "/etc/git/server.gitconfig",

    GIT_CONFIG_GLOBAL: "/dev/null",

    // 資格情報を対話で聞かせない。聞かれると、応答が返らないまま上限まで待つことになる
    GIT_TERMINAL_PROMPT: "0",

    GIT_ASKPASS: "/bin/false",

    GIT_EDITOR: "true",

    GIT_PAGER: "cat",

    ...extra,

    ...configEnv([...HARDENED_CONFIG, ...config]),
  };
}

/**
 * GitHub のトークンを、argv にもディスクにも残さずに渡す。
 *
 * `-c http.extraheader=...` は `ps` から見えてしまい、`.git/config` に書くと残ります。
 * GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n なら、その子プロセスの環境だけで完結します。
 * 番号は childEnv が HARDENED_CONFIG の後ろに続けて振ります。
 */
export function credentialConfig(): GitConfigEntry[] {
  if (!config.githubToken) {
    return [];
  }

  const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");

  return [["http.https://github.com/.extraheader", `Authorization: Basic ${basic}`]];
}

// 値の位置に "-" で始まる文字列が入ると、git がそれをオプションとして読む。
// --upload-pack=... という名前のブランチを渡されないよう、値はすべてここを通す
export function checkValue(value: unknown, label: string): string {
  const text = String(value);

  if (text === "" || text.startsWith("-") || text.includes("\0") || text.includes("\n")) {
    throw new Error(`Invalid value for ${label}: ${JSON.stringify(text)}`);
  }

  return text;
}

const TRUNCATION_NOTE = `\n... [truncated at ${MAX_OUTPUT_CHARS} characters; narrow the request]`;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_OUTPUT_CHARS)}${TRUNCATION_NOTE}`;
}

/**
 * 切り詰めの但し書きを本文から分ける。
 * 差分から区画を落とすとき、但し書きが落とす区画の末尾に付いていると一緒に消え、
 * 途中で切れたことが分からなくなる。先に外し、落としたあとで戻す
 */
export function splitTruncation(text: string): { body: string; truncated: boolean } {
  return text.endsWith(TRUNCATION_NOTE)
    ? { body: text.slice(0, -TRUNCATION_NOTE.length), truncated: true }
    : { body: text, truncated: false };
}

export function truncationNote(): string {
  return TRUNCATION_NOTE.trim();
}

/**
 * git を起動する。
 *
 * argv は必ず配列で渡し、shell は使いません。
 * 利用者の値は「値」の位置にしか入らず、サブコマンドとオプションは呼び出し側が決め打ちします。
 */
export function runGit(
  args: string[],
  { cwd, env = {}, config: extraConfig = [], signal, onProgress }: GitOptions = {},
): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,

      env: childEnv(env, extraConfig),

      stdio: ["ignore", "pipe", "pipe"],

      shell: false,
    });

    let stdout = "";

    let stderr = "";

    let settled = false;

    const started = Date.now();

    // 何も出てこない時間と、全体の時間の両方に上限を設ける
    let idle = setTimeout(() => stop("timeout"), config.gitTimeout);

    const overall = setTimeout(() => stop("max-duration"), config.gitMaxDuration);

    const ticker = onProgress
      ? setInterval(() => onProgress({ elapsedMs: Date.now() - started }), 10000)
      : undefined;

    function bump() {
      clearTimeout(idle);

      idle = setTimeout(() => stop("timeout"), config.gitTimeout);
    }

    function cleanup() {
      clearTimeout(idle);

      clearTimeout(overall);

      if (ticker) {
        clearInterval(ticker);
      }

      signal?.removeEventListener("abort", onAbort);
    }

    function stop(reason: "timeout" | "max-duration" | "aborted"): void {
      if (settled) {
        return;
      }

      settled = true;

      cleanup();

      child.kill("SIGKILL");

      reject(
        new Error(
          reason === "aborted"
            ? "git was cancelled by the client"
            : `git did not finish in time (${reason}); narrow the request`,
        ),
      );
    }

    const onAbort = () => stop("aborted");

    signal?.addEventListener("abort", onAbort, { once: true });

    // stdio を "pipe" で起動しているため必ず存在するが、型の上では null になりうる
    child.stdout?.on("data", (chunk: Buffer) => {
      bump();

      if (stdout.length < MAX_OUTPUT_CHARS * 2) {
        stdout += chunk;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      bump();

      if (stderr.length < MAX_OUTPUT_CHARS) {
        stderr += chunk;
      }
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;

      cleanup();

      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("git is not installed in this container; rebuild the image")
          : error,
      );
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;

      cleanup();

      resolve({
        code,

        stdout: truncate(stdout),

        stderr: truncate(stderr),

        elapsedMs: Date.now() - started,
      });
    });
  });
}

/**
 * git を起動し、失敗したらそのまま例外にする。
 * トークンが混ざることはないが、念のため出力からは取り除く。
 */
export async function git(args: string[], options: GitOptions = {}): Promise<string> {
  const result = await runGit(args, options);

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();

    throw new Error(`git ${args[0]} failed (exit ${result.code}): ${scrub(detail)}`);
  }

  return scrub(result.stdout);
}

// 万一トークンが出力に混ざっても、そのまま応答に載せない
export function scrub(text: string): string {
  if (!config.githubToken) {
    return text;
  }

  return text.split(config.githubToken).join("***");
}
