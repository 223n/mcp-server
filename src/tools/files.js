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

// 一覧で中に入らないディレクトリ（依存やビルドの出力で、数が多く役に立たない）
const SKIPPED_DIRS = /^(node_modules|vendor|\.svn|\.hg|__pycache__|\.venv|\.cache)$/i;

const LIST_MAX_DEPTH = 8;

const LIST_DEFAULT_ENTRIES = 200;

const LIST_MAX_ENTRIES = 1000;

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
async function verifyComponents(realRoot, realLocal, input, kind) {
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

    const secret =
      !isLast || kind === "dir"
        ? SENSITIVE_DIRS.test(actual)
        : SENSITIVE_FILES.some((p) => p.test(actual));

    if (secret) {
      throw new Error(`Refusing to read a file that may contain secrets: ${input}`);
    }

    current = `${current}/${actual}`;
  }
}

async function resolvePath(input, kind = "file") {
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

    await verifyComponents(normalizedRoot, normalizedLocal, input, kind);

    return { local: normalizedLocal, root, realRoot: normalizedRoot };
  }

  throw new Error(`Path is outside the allowed roots (${fileRootsLabel()}): ${input}`);
}

// コンテナー内のパスを、Claude が files に渡せるホスト側の表記に戻す
function toHostPath(local, root, realRoot) {
  const relative = local.slice(realRoot.length).replace(/^\/+/, "");

  const separator = root.hostLabel.includes("\\") ? "\\" : "/";

  const base = root.hostLabel.replace(/[\\/]+$/, "");

  return relative ? base + separator + relative.split("/").join(separator) : base;
}

// "**/*.php" のようなグロブを正規表現にする。** は 0 段以上のディレクトリ、* と ? は 1 段の中だけに当たる
function globToRegExp(pattern) {
  let source = "";

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";

      source += slash ? "(?:.*/)?" : ".*";

      i += slash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`, "i");
}

export async function listFiles({ path: input, pattern = "*", maxEntries = LIST_DEFAULT_ENTRIES } = {}) {
  if (config.fileRoots.length === 0) {
    throw new Error("File access is disabled on this server (FILE_ROOTS is not set)");
  }

  if (!input) {
    return `Allowed roots (pass one as \`path\`):\n${config.fileRoots.map((root) => root.hostLabel).join("\n")}`;
  }

  const normalizedPattern = toUnix(pattern.trim()).replace(/^\.\//, "");

  if (normalizedPattern.startsWith("/") || normalizedPattern.split("/").includes("..")) {
    throw new Error("`pattern` must be relative to `path` and must not contain `..`");
  }

  const matcher = globToRegExp(normalizedPattern);

  const limit = Math.min(maxEntries, LIST_MAX_ENTRIES);

  const { local, root, realRoot } = await resolvePath(input, "dir");

  if (!(await stat(local)).isDirectory()) {
    throw new Error(`Not a directory: ${input}`);
  }

  const results = [];

  let truncated = false;

  // 幅優先でたどる。シンボリックリンクはたどらず、秘密のディレクトリや依存のディレクトリにも入らない
  const queue = [{ dir: local, relative: "", depth: 0 }];

  while (queue.length > 0 && !truncated) {
    const { dir, relative, depth } = queue.shift();

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;

      const childLocal = `${dir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (SENSITIVE_DIRS.test(entry.name) || SKIPPED_DIRS.test(entry.name)) {
          continue;
        }

        if (matcher.test(childRelative)) {
          results.push(`${toHostPath(childLocal, root, realRoot)}${root.hostLabel.includes("\\") ? "\\" : "/"}`);
        }

        if (depth + 1 < LIST_MAX_DEPTH) {
          queue.push({ dir: childLocal, relative: childRelative, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        if (SENSITIVE_FILES.some((p) => p.test(entry.name)) || !matcher.test(childRelative)) {
          continue;
        }

        const size = await stat(childLocal)
          .then((info) => info.size)
          .catch(() => 0);

        results.push(`${toHostPath(childLocal, root, realRoot)} (${Math.max(1, Math.round(size / 1024))} KB)`);
      }

      if (results.length >= limit) {
        truncated = true;

        break;
      }
    }
  }

  if (results.length === 0) {
    return `No entries matched \`${normalizedPattern}\` under ${input}.`;
  }

  const note = truncated
    ? `\n(truncated at ${limit} entries; narrow \`pattern\` or \`path\`)`
    : "";

  return results.join("\n") + note;
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
    const { local } = await resolvePath(input, "file");

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
