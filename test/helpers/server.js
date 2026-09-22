import { spawn } from "node:child_process";

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";

import { createServer } from "node:net";

import { tmpdir } from "node:os";

import path from "node:path";

import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 空いているポートを1つ取る
export async function freePort() {
  const server = createServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address();

  await new Promise((resolve) => server.close(resolve));

  return port;
}

// 試験用のファイルを置いた一時ディレクトリを作る
export function createFileTree() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-files-")));

  const files = {
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

// index.js を起動し、待ち受けを始めるまで待つ
export async function startHttpServer(env) {
  const port = await freePort();

  // cwd を一時ディレクトリにして、手元の .env を読ませない
  const child = spawn(process.execPath, [path.join(ROOT, "index.js")], {
    cwd: tmpdir(),

    env: { ...cleanEnv(), HOST: "127.0.0.1", PORT: String(port), ...env },

    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";

  child.stdout.on("data", (chunk) => (output += chunk));

  child.stderr.on("data", (chunk) => (output += chunk));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10000);

    child.stdout.on("data", () => {
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
      new Promise((resolve) => {
        child.once("exit", resolve);

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
    "PORT",
    "HOST",
    "ALLOWED_HOSTS",
    "FILE_ROOTS",
    "HTTP_ALLOW_FILES",
    "MCP_AUTH_TOKEN",
    "CF_ACCESS_TEAM_DOMAIN",
    "CF_ACCESS_AUD",
    "CF_ACCESS_ALLOWED_EMAILS",
  ]) {
    delete env[key];
  }

  return env;
}

export const text = (result) => result.content?.map((c) => c.text).join("\n") ?? "";
