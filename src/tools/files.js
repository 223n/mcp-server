import { readdir, readFile, realpath, stat } from "node:fs/promises";

import path from "node:path";

import { config } from "../config/config.js";

const MAX_FILE_BYTES = 512 * 1024;

// qwen2.5-coder のコンテキスト長 32k トークンに収まる入力量の目安
const MAX_TOTAL_CHARS = 90000;

// 秘密情報を含みやすいファイル名（大文字小文字は区別しない）
const SENSITIVE_FILES = [
  /^\.env(?!\.(example|sample|template|dist)$)(\..+)?$/i,
  /^\.env[-_]/i,
  /\.env$/i,
  /^\.envrc$/i,
  /\.(pem|key|p12|pfx|keystore|jks|ppk|kdbx|tfstate|tfvars)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.?credentials(\.(json|ya?ml|xml|ini|toml))?$/i,
  /^\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc|pgpass|htpasswd|git-credentials|dockercfg)$/i,
  /^_netrc$/i,
  /^secrets?\.(json|ya?ml|toml|ini|env|php|xml)$/i,
  /^service[-_]?account.*\.json$/i,
  /^token$/i,
  /^app_local\.php$/i,
  /^wp-config\.php$/i,
];

// 秘密情報を置く慣習のあるディレクトリ名
const SENSITIVE_DIRS = /^\.(ssh|aws|azure|gcloud|gnupg|docker|kube|git|cloudflared)$/i;

export function fileRootsLabel() {
  return config.fileRoots.map((root) => root.hostLabel).join(", ");
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + "/");
}

function toUnix(p) {
  return p.replace(/\\/g, "/");
}

// パスの各段を実際のディレクトリ一覧と照合する。
// Windows の 8.3 形式の短い名前（例: ENV~1 → .env）は一覧に現れないので、ここで弾かれる。
// 拒否リストの判定も、入力された名前ではなく実際の名前に対して行う。
async function verifyComponents(realRoot, realLocal, input) {
  const parts = realLocal.slice(realRoot.length).split("/").filter(Boolean);

  let current = realRoot;

  for (const [index, part] of parts.entries()) {
    const entries = await readdir(current);

    const actual = entries.includes(part)
      ? part
      : entries.find((entry) => entry.toLowerCase() === part.toLowerCase());

    if (!actual) {
      throw new Error(`Use the full (long) path name, short or aliased names are not supported: ${input}`);
    }

    const isLast = index === parts.length - 1;

    if ((!isLast && SENSITIVE_DIRS.test(actual)) || (isLast && SENSITIVE_FILES.some((p) => p.test(actual)))) {
      throw new Error(`Refusing to read a file that may contain secrets: ${input}`);
    }

    current = `${current}/${actual}`;
  }
}

async function resolveFilePath(input) {
  const unified = toUnix(input.trim());

  const lower = unified.toLowerCase();

  for (const root of config.fileRoots) {
    let local;

    if (isInside(lower, root.hostPrefix)) {
      local = path.posix.normalize(root.localPath + unified.slice(root.hostPrefix.length));
    } else if (isInside(unified, root.localPath)) {
      local = path.posix.normalize(unified);
    } else {
      continue;
    }

    if (!isInside(local, root.localPath)) {
      break;
    }

    // シンボリックリンクで許可ルートの外へ出るのも防ぐ
    const [realLocal, realRoot] = await Promise.all([
      realpath(local),
      realpath(root.localPath),
    ]).catch(() => {
      throw new Error(`File not found: ${input}`);
    });

    const normalizedLocal = toUnix(realLocal);

    const normalizedRoot = toUnix(realRoot);

    if (!isInside(normalizedLocal, normalizedRoot)) {
      break;
    }

    await verifyComponents(normalizedRoot, normalizedLocal, input);

    return realLocal;
  }

  throw new Error(`Path is outside the allowed roots (${fileRootsLabel()}): ${input}`);
}

export function fenceFor(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));

  return "`".repeat(Math.max(3, longest + 1));
}

export function numberLines(lines) {
  const width = String(lines.length).length;

  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`).join("\n");
}

export async function loadFiles(paths, { lineNumbers = false } = {}) {
  if (config.fileRoots.length === 0) {
    throw new Error("File access is disabled on this server (FILE_ROOTS is not set)");
  }

  const blocks = [];

  let total = 0;

  for (const input of paths) {
    const local = await resolveFilePath(input);

    const name = path.posix.basename(toUnix(local));

    const info = await stat(local);

    if (!info.isFile()) {
      throw new Error(`Not a regular file: ${input}`);
    }

    if (info.size > MAX_FILE_BYTES) {
      throw new Error(
        `File too large (${info.size} bytes > ${MAX_FILE_BYTES}): ${input}. Pass a smaller excerpt via the text argument instead.`,
      );
    }

    const text = await readFile(local, "utf8");

    if (text.includes(String.fromCharCode(0))) {
      throw new Error(`Binary file is not supported: ${input}`);
    }

    const lines = text.replace(/\r\n/g, "\n").split("\n");

    const body = lineNumbers ? numberLines(lines) : lines.join("\n");

    total += body.length;

    if (total > MAX_TOTAL_CHARS) {
      throw new Error(
        `Input too large for the local model's context (> ${MAX_TOTAL_CHARS} chars in total). Split the files into several calls.`,
      );
    }

    const fence = fenceFor(body);

    const extension = path.posix.extname(name).slice(1);

    blocks.push(
      `### File: ${input} (${lines.length} lines)\n${fence}${extension}\n${body}\n${fence}`,
    );
  }

  return blocks.join("\n\n");
}
