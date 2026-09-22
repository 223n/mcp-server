import { spawn } from "node:child_process";

import { config } from "../config/config.js";

// 応答に載せる出力の上限。git log や git diff は簡単に数MBになる
const MAX_OUTPUT_CHARS = 60000;

/**
 * git の子プロセスに渡す環境変数。
 *
 * 継承しないことが防御の本体です。
 * GIT_SSH_COMMAND、GIT_EXTERNAL_DIFF、GIT_PROXY_COMMAND、GIT_ALTERNATE_OBJECT_DIRECTORIES、
 * LD_PRELOAD は、どれも任意のコマンドを実行させる経路になります。
 *
 * GIT_CONFIG_SYSTEM でサーバーが用意した 1 枚だけを読ませ、/etc/gitconfig と
 * 利用者のグローバル設定と、取得したリポジトリの .git/config の危険なキーを効かせません。
 */
function childEnv(extra = {}) {
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
  };
}

/**
 * GitHub のトークンを、argv にもディスクにも残さずに渡す。
 *
 * `-c http.extraheader=...` は `ps` から見えてしまい、`.git/config` に書くと残ります。
 * GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n なら、その子プロセスの環境だけで完結します。
 */
export function credentialEnv() {
  if (!config.githubToken) {
    return {};
  }

  const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");

  return {
    GIT_CONFIG_COUNT: "1",

    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",

    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

// 値の位置に "-" で始まる文字列が入ると、git がそれをオプションとして読む。
// --upload-pack=... という名前のブランチを渡されないよう、値はすべてここを通す
export function checkValue(value, label) {
  const text = String(value);

  if (text === "" || text.startsWith("-") || text.includes("\0") || text.includes("\n")) {
    throw new Error(`Invalid value for ${label}: ${JSON.stringify(text)}`);
  }

  return text;
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated at ${MAX_OUTPUT_CHARS} characters; narrow the request]`;
}

/**
 * git を起動する。
 *
 * argv は必ず配列で渡し、shell は使いません。
 * 利用者の値は「値」の位置にしか入らず、サブコマンドとオプションは呼び出し側が決め打ちします。
 */
export function runGit(args, { cwd, env = {}, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,

      env: childEnv(env),

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

    function stop(reason) {
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

    child.stdout.on("data", (chunk) => {
      bump();

      if (stdout.length < MAX_OUTPUT_CHARS * 2) {
        stdout += chunk;
      }
    });

    child.stderr.on("data", (chunk) => {
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
        error.code === "ENOENT"
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
export async function git(args, options = {}) {
  const result = await runGit(args, options);

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();

    throw new Error(`git ${args[0]} failed (exit ${result.code}): ${scrub(detail)}`);
  }

  return scrub(result.stdout);
}

// 万一トークンが出力に混ざっても、そのまま応答に載せない
export function scrub(text) {
  if (!config.githubToken) {
    return text;
  }

  return text.split(config.githubToken).join("***");
}
