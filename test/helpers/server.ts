import { spawn } from "node:child_process";

import type { AddressInfo } from "node:net";

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { createServer } from "node:net";

import { tmpdir } from "node:os";

import path from "node:path";

import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 試験だけが使う空のディレクトリ。作業ディレクトリにして、手元や共有の一時ディレクトリの .env を読ませない
export const WORK_DIR = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-cwd-")));

const createdTrees = [WORK_DIR];

// 試験で作ったディレクトリを消す。各試験のファイルの after() から呼ぶ
export function removeCreatedTrees() {
  // Windows では作業ディレクトリを消せないため、先に外へ出る
  process.chdir(tmpdir());

  for (const tree of createdTrees.splice(0)) {
    rmSync(tree, { recursive: true, force: true });
  }
}

// 空いているポートを1つ取る
export async function freePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

// 試験用のファイルを置いた一時ディレクトリを作る
export function createFileTree() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-files-")));

  createdTrees.push(root);

  const files: Record<string, string> = {
    "app/src/Main.php": "<?php\necho 'hello';\n",
    "app/src/lib/util.js": "export const x = 1;\n",
    "app/README.md": "# app\n",
    "app/.env": "SECRET=do-not-read\n",
    "app/.env.example": "SECRET=\n",
    "app/.npmrc": "//registry.npmjs.org/:_authToken=secret\n",
    "app/config/app_local.php": "<?php return ['password' => 'secret'];\n",
    "app/.git/config": "[remote]\n",
    "app/node_modules/pkg/index.js": "module.exports = 1;\n",
    "app/vendor/lib/Lib.php": "<?php\n",
    "app/.dev.vars": "API_KEY=secret\n",
    "app/acme.json": "{}\n",
    "app/secrets/db.txt": "password\n",
    "app/.ssh/config": "Host github.com\n",
    "app/.ssh/known_hosts": "github.com ssh-rsa AAAA\n",
    "app/.kube/config": "apiVersion: v1\n",
    "app/.mcp.json": "{\"token\":\"secret\"}\n",
    "deep/1/2/3/4/5/6/7/8/9/deep.php": "<?php\n",
    "binary.bin": `a${String.fromCharCode(0)}b`,
    "big.txt": "x".repeat(600 * 1024),
  };

  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);

    mkdirSync(path.dirname(full), { recursive: true });

    writeFileSync(full, content);
  }

  return root;
}

// index.ts を起動し、待ち受けを始めるまで待つ
export async function startHttpServer(env?: NodeJS.ProcessEnv) {
  const port = await freePort();

  // cwd を試験用の空のディレクトリにして、.env を読ませない
  const child = spawn(process.execPath, [path.join(ROOT, "index.ts")], {
    cwd: WORK_DIR,

    env: { ...cleanEnv(), HOST: "127.0.0.1", PORT: String(port), ...env },

    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";

  child.stdout?.on("data", (chunk: Buffer) => (output += chunk));

  child.stderr?.on("data", (chunk: Buffer) => (output += chunk));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10000);

    child.stdout?.on("data", () => {
      if (output.includes("listening on")) {
        clearTimeout(timer);

        resolve();
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);

      reject(new Error(`server exited with ${code}:\n${output}`));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,

    output: () => output,

    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());

        child.kill("SIGTERM");
      }),
  };
}

// 手元の .env や環境変数に左右されないよう、サーバーの設定に関わる変数を外す
export function cleanEnv() {
  const env = { ...process.env };

  for (const key of [
    "OLLAMA_URL",
    "DEFAULT_MODEL",
    "DEEP_MODEL",
    "OLLAMA_TIMEOUT",
    "OLLAMA_MAX_DURATION",
    "OLLAMA_MAX_CONCURRENCY",
    "OLLAMA_MAX_QUEUE",
    "HTTP_REQUEST_TIMEOUT",
    "PORT",
    "HOST",
    "ALLOWED_HOSTS",
    "FILE_ROOTS",
    "HTTP_ALLOW_FILES",
    "OUTPUT_DIR",
    "HTTP_ALLOW_WRITES",
    "CLONE_ROOT",
    "GIT_ALLOWED_OWNERS",
    "GIT_ALLOW_WRITE",
    "GIT_TIMEOUT",
    "GIT_MAX_DURATION",
    "GIT_USER_NAME",
    "GIT_USER_EMAIL",
    "GITHUB_MCP_TOKEN",
    "GITHUB_ALLOW_WRITE",
    "MCP_AUTH_TOKEN",
    "CF_ACCESS_TEAM_DOMAIN",
    "CF_ACCESS_AUD",
    "CF_ACCESS_ALLOWED_EMAILS",
  ]) {
    delete env[key];
  }

  return env;
}

/** tools/call や resources/read の応答から、テキストの塊だけをつないで取り出す */
export const text = (result: unknown): string =>
  (result as { content?: { text?: string }[] })?.content?.map((c) => c.text).join("\n") ?? "";
