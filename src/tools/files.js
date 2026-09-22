import { constants as fsConstants } from "node:fs";

import { open, readdir, realpath, stat } from "node:fs/promises";

import path from "node:path";

import { config } from "../config/config.js";

import { compileGlob } from "./glob.js";

const MAX_FILE_BYTES = 512 * 1024;

// qwen2.5-coder のコンテキスト長 32k トークンのうち、渡すファイルに使ってよい量の目安。
// 残りは system プロンプト、利用者の指示、出力（既定 4096）に充てる。
// 文字数で測ると、日本語のコメントが多いコードで大きく外れるため、トークン数の目安で測る
const MAX_PROMPT_TOKENS = 24000;

// グロブ 1 件が展開してよいファイル数の上限
const MAX_EXPANDED_FILES = 40;

// 1 回の呼び出しでたどるディレクトリの数と時間の上限
const EXPAND_MAX_DIRS = 5000;

const EXPAND_TIME_BUDGET_MS = 10000;

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
  /^\.dev\.vars/i,
  /\.tfstate(\.backup)?$/i,
  /\.p8$/i,
  /^\.vault-token$/i,
  /^client_secret.*\.json$/i,
  /^acme\.json$/i,
  /^google-services\.json$/i,
  /^GoogleService-Info\.plist$/i,
  // ここから下は、グロブでまとめて拾うようになったことで必要になったもの。
  // 「名前を知っている 1 件の誤読を止める」大きさでは、掃き出しに足りない
  /^\.?env[.\-_](?!(example|sample|template|dist)$)/i,
  /^(appsettings|local\.settings)(\..+)?\.json$/i,
  /^web\.config$/i,
  /^\.htaccess$/i,
  /\.(crt|cer|der)$/i,
  /^\.(bash|zsh|mysql|psql)_history$/i,
  /^settings\.local\.json$/i,
  /^docker-compose\.override\.ya?ml$/i,
  /^\.mcp\.json$/i,
];

// 秘密情報を置く慣習のあるディレクトリ名
const SENSITIVE_DIRS = /^(\.(ssh|aws|azure|gcloud|gnupg|docker|kube|git|cloudflared|wrangler|terraform)|secrets?)$/i;

// 一覧で中に入らないディレクトリ（依存やビルドの出力で、数が多く役に立たない）
const SKIPPED_DIRS = /^(node_modules|vendor|\.svn|\.hg|__pycache__|\.venv|\.cache)$/i;

// グロブで拾ってよい拡張子。
// 名前を明示して渡すときは拒否リストで足りるが、グロブは「サーバーが選ぶ」ため、
// 拒否リストに載っていないだけの秘密のファイル（env.bak、.mcp.json、database.php など）が
// まとめて入り込む。展開のときだけは、拾う側を許可リストで絞る
// .sql と .csv（ダンプ）、.ini や .conf（資格情報が混ざりやすい）は入れない。
// これらを渡したいときは、パスを明示すれば従来どおり読める
const EXPANDABLE_EXTENSIONS = new Set([
  "bash", "c", "cc", "cjs", "cpp", "cs", "css", "dart", "ex", "exs", "go", "gradle", "graphql",
  "h", "hpp", "htm", "html", "java", "js", "json", "jsx", "kt", "less", "lua", "md", "mjs", "mts",
  "php", "pl", "ps1", "py", "rb", "rs", "sass", "scala", "scss", "sh", "svelte", "swift", "toml",
  "ts", "tsx", "twig", "txt", "vue", "xml", "yaml", "yml", "zsh",
]);

const LIST_MAX_DEPTH = 8;

const LIST_DEFAULT_ENTRIES = 200;

const LIST_MAX_ENTRIES = 1000;

// 1回の一覧でたどるディレクトリの数と時間の上限（C:\dev の全体でも数秒で終わる量）
const LIST_MAX_DIRS = 20000;

const LIST_TIME_BUDGET_MS = 15000;

// 読み取りが参照するルート。
// OUTPUT_DIR は、保存した下書きを読み返せないと使い物にならないため、読み取り側にも加える。
// 許可ルートの中に置かれているときは、二重に持たない
export function readRoots() {
  const output = config.outputDir;

  if (!output) {
    return config.fileRoots;
  }

  const inside = config.fileRoots.some((root) => isInside(output.localPath, root.localPath));

  return inside ? config.fileRoots : [...config.fileRoots, output];
}

export function fileRootsLabel() {
  return readRoots()
    .map((root) => root.hostLabel)
    .join(", ");
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + "/");
}

function toUnix(p) {
  return p.replace(/\\/g, "/");
}

// 入力の量をトークン数の目安で測る。
// ASCII はおよそ 1 トークンあたり 3.5 文字、日本語や中国語の文字はほぼ 1 文字 1 トークンになる。
// 文字数だけで測ると、日本語のコメントが多いコードで 2 倍以上ずれる
export function estimateTokens(text) {
  let wide = 0;

  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) {
      wide += 1;
    }
  }

  return Math.ceil((text.length - wide) / 3.5 + wide);
}

// パスの各段を実際のディレクトリ一覧と照合する。
// Windows の 8.3 形式の短い名前（例: ENV~1 → .env）は一覧に現れないので、ここで弾かれる。
// 拒否リストの判定も、入力された名前ではなく実際の名前に対して行う。
async function verifyComponents(realRoot, realLocal, input) {
  const parts = realLocal.slice(realRoot.length).split("/").filter(Boolean);

  let current = realRoot;

  for (const part of parts) {
    const entries = await readdir(current);

    const actual = entries.includes(part)
      ? part
      : entries.find((entry) => entry.toLowerCase() === part.toLowerCase());

    if (!actual) {
      throw new Error(`Use the full (long) path name, short or aliased names are not supported: ${input}`);
    }

    // どの段も、ファイルの拒否リストとディレクトリの拒否リストの両方で判定する。
    // 「最後の段はファイルだから SENSITIVE_FILES だけ」にすると、ディレクトリを渡したときに
    // .ssh や .kube や secrets が通り、逆に「ディレクトリとして解決したから SENSITIVE_DIRS だけ」に
    // すると .env が通る。ここは入口ごとに変えず、常に両方で拒む
    const secret =
      SENSITIVE_DIRS.test(actual) || SENSITIVE_FILES.some((pattern) => pattern.test(actual));

    if (secret) {
      throw new Error(`Refusing to read a file that may contain secrets: ${input}`);
    }

    current = `${current}/${actual}`;
  }
}

async function resolvePath(input) {
  const unified = toUnix(input.trim());

  const lower = unified.toLowerCase();

  for (const root of readRoots()) {
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

export async function listFiles({
  path: input,
  pattern = "*",
  maxEntries = LIST_DEFAULT_ENTRIES,
  signal,
} = {}) {
  if (readRoots().length === 0) {
    throw new Error("File access is disabled on this server (FILE_ROOTS is not set)");
  }

  if (!input) {
    return `Allowed roots (pass one as \`path\`):\n${readRoots()
      .map((root) => root.hostLabel)
      .join("\n")}`;
  }

  const matcher = compileGlob(pattern);

  const limit = Math.min(maxEntries, LIST_MAX_ENTRIES);

  const { local, root, realRoot } = await resolvePath(input);

  if (!(await stat(local)).isDirectory()) {
    throw new Error(`Not a directory: ${input}`);
  }

  const separator = root.hostLabel.includes("\\") ? "\\" : "/";

  const started = Date.now();

  const results = [];

  let truncated = false;

  let depthLimited = false;

  let budgetExceeded = false;

  let visited = 0;

  // 幅優先でたどる。シンボリックリンクはたどらず、秘密のディレクトリや依存のディレクトリにも入らない。
  // depth は「path の直下」を 0 とした深さで、パターンが当たりうる深さより下には降りない
  const queue = [{ dir: local, relative: "", depth: 0 }];

  walk: while (queue.length > 0) {
    signal?.throwIfAborted();

    if (visited >= LIST_MAX_DIRS || Date.now() - started > LIST_TIME_BUDGET_MS) {
      budgetExceeded = true;

      break;
    }

    const { dir, relative, depth } = queue.shift();

    visited += 1;

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;

      const childLocal = `${dir}/${entry.name}`;

      let line;

      if (entry.isDirectory()) {
        if (SENSITIVE_DIRS.test(entry.name) || SKIPPED_DIRS.test(entry.name)) {
          continue;
        }

        if (matcher.test(childRelative, true)) {
          line = `${toHostPath(childLocal, root, realRoot)}${separator}`;
        }

        // この下の項目は depth + 2 段になる
        if (depth + 2 <= matcher.maxDepth) {
          if (depth + 1 < LIST_MAX_DEPTH) {
            queue.push({ dir: childLocal, relative: childRelative, depth: depth + 1 });
          } else {
            depthLimited = true;
          }
        }
      } else if (entry.isFile()) {
        if (SENSITIVE_FILES.some((p) => p.test(entry.name)) || !matcher.test(childRelative, false)) {
          continue;
        }

        const size = await stat(childLocal)
          .then((info) => info.size)
          .catch(() => 0);

        line = `${toHostPath(childLocal, root, realRoot)} (${Math.max(1, Math.round(size / 1024))} KB)`;
      }

      if (line === undefined) {
        continue;
      }

      // 上限の件数を超える一致が見つかったときだけ「打ち切った」とする
      if (results.length >= limit) {
        truncated = true;

        break walk;
      }

      results.push(line);
    }
  }

  const notes = [];

  if (truncated) {
    notes.push(`(truncated at ${limit} entries; narrow \`pattern\` or \`path\`)`);
  }

  if (depthLimited) {
    notes.push(
      `(directories more than ${LIST_MAX_DEPTH} levels below \`path\` were not searched; pass a deeper \`path\`)`,
    );
  }

  if (budgetExceeded) {
    notes.push(`(stopped after visiting ${visited} directories; narrow \`path\` or \`pattern\`)`);
  }

  const body =
    results.length > 0
      ? results.join("\n")
      : `No entries matched \`${pattern}\` under ${input}. Supported syntax: \`*\`, \`?\`, \`**\`, \`{a,b}\`, and a trailing \`/\` for directories only.`;

  return [body, ...notes].join("\n");
}

export function fenceFor(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));

  return "`".repeat(Math.max(3, longest + 1));
}

// 行番号を付ける。startLine は先頭の行が元のファイルで何行目かを表す。
// 行範囲で切り出したときに 1 から振り直すと、ollama_review_code の指摘が
// 元のファイルの別の行を指してしまうため、必ず元の行番号で振る
export function numberLines(lines, startLine = 1) {
  const width = String(startLine + Math.max(0, lines.length - 1)).length;

  return lines.map((line, i) => `${String(startLine + i).padStart(width)}| ${line}`).join("\n");
}

const LINE_RANGE = /#L(\d+)(?:-L?(\d*))?$/;

// "C:\dev\app\src\Main.php#L10-200" を、パスと行範囲に分ける。
// GitHub の永続リンクと同じ書き方で、"#L10"（1 行）、"#L10-200"、"#L10-L200"、"#L10-"（末尾まで）を取る。
// "#" はファイル名にも使えるため、範囲として読めなければパスの一部として扱う
export function splitLineRange(input) {
  const match = LINE_RANGE.exec(input);

  if (!match) {
    return { path: input };
  }

  const start = Number(match[1]);

  const end = match[2] === undefined ? start : match[2] === "" ? Number.POSITIVE_INFINITY : Number(match[2]);

  if (start < 1 || end < start) {
    throw new Error(`Invalid line range in \`files\`: ${input} (use \`path#L10-200\`)`);
  }

  return { path: input.slice(0, match.index), start, end };
}

// 展開で拾ってよい名前か。
// 先頭が "." の名前は拡張子の許可リストを素通りする（.mcp.json → json）ため、
// 名前の側で先に落とす。拡張子を持たないファイルも展開では拾わない
function expandable(name) {
  if (name.startsWith(".")) {
    return false;
  }

  const extension = path.posix.extname(name).slice(1).toLowerCase();

  return extension !== "" && EXPANDABLE_EXTENSIONS.has(extension);
}

// 絶対パスのグロブを、固定の部分（たどり始めるディレクトリ）とパターンに分ける
function splitGlob(input) {
  const segments = toUnix(input).split("/");

  const wildcard = segments.findIndex((segment) => /[*?{]/.test(segment));

  if (wildcard <= 0) {
    throw new Error(`\`files\` pattern must start with an absolute path under ${fileRootsLabel()}: ${input}`);
  }

  return {
    base: segments.slice(0, wildcard).join("/"),

    pattern: segments.slice(wildcard).join("/"),
  };
}

// グロブに当たるファイルを集める。listFiles と同じ防御を通し、拡張子の許可リストでさらに絞る
async function expandGlob(input, signal) {
  const { base, pattern } = splitGlob(input);

  const matcher = compileGlob(pattern);

  const { local, root, realRoot } = await resolvePath(base);

  if (!(await stat(local)).isDirectory()) {
    throw new Error(`Not a directory: ${base}`);
  }

  const started = Date.now();

  const found = [];

  const queue = [{ dir: local, relative: "", depth: 0 }];

  let visited = 0;

  while (queue.length > 0) {
    signal?.throwIfAborted();

    if (visited >= EXPAND_MAX_DIRS || Date.now() - started > EXPAND_TIME_BUDGET_MS) {
      throw new Error(`\`files\` pattern searched too many directories, narrow it: ${input}`);
    }

    const { dir, relative, depth } = queue.shift();

    visited += 1;

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

        if (depth + 2 <= matcher.maxDepth && depth + 1 < LIST_MAX_DEPTH) {
          queue.push({ dir: childLocal, relative: childRelative, depth: depth + 1 });
        }

        continue;
      }

      if (!entry.isFile() || !matcher.test(childRelative, false)) {
        continue;
      }

      if (SENSITIVE_FILES.some((p) => p.test(entry.name)) || !expandable(entry.name)) {
        continue;
      }

      // ハードリンクは realpath でも許可ルートの中に見えるため、名前の検査では止まらない。
      // 展開のときだけ、リンク数が 1 より多い通常ファイルを飛ばす
      const linked = await stat(childLocal)
        .then((info) => info.nlink > 1)
        .catch(() => true);

      if (linked) {
        continue;
      }

      // 展開しすぎたら切り詰めずにエラーにする。
      // 当てるつもりのなかったものまで拾っているため、勝手に一部だけ読むとレビューの見落としになる
      if (found.length >= MAX_EXPANDED_FILES) {
        throw new Error(
          `\`files\` pattern matched more than ${MAX_EXPANDED_FILES} files, narrow it: ${input}`,
        );
      }

      found.push({ local: childLocal, display: toHostPath(childLocal, root, realRoot) });
    }
  }

  if (found.length === 0) {
    throw new Error(`\`files\` pattern matched no readable files: ${input}`);
  }

  return found;
}

// files の 1 件を、読み込むファイルの一覧に変える
async function resolveItem(input, signal) {
  if (/[*?{]/.test(input)) {
    return await expandGlob(input, signal);
  }

  const range = splitLineRange(input);

  // "#" を含むファイル名かもしれないので、範囲として切り落とした側が解決できなければ、元の文字列で試す
  let resolved;

  try {
    resolved = await resolvePath(range.path);
  } catch (error) {
    if (range.path === input) {
      throw error;
    }

    resolved = await resolvePath(input);

    return [{ local: resolved.local, display: input }];
  }

  const info = await stat(resolved.local);

  if (info.isDirectory()) {
    throw new Error(
      `\`${input}\` is a directory. Pass \`${input}${input.includes("\\") ? "\\" : "/"}*\` for its files, or a pattern such as \`**/*.php\`.`,
    );
  }

  return [{ local: resolved.local, display: range.path, start: range.start, end: range.end }];
}

// 中身を読んで、1 ファイル分の材料にする。
// stat と read を同じファイルハンドルに対して行い、検査したファイルと読むファイルがすり替わらないようにする
async function readPart({ local, display, start, end }, { lineNumbers }) {
  const handle = await open(local, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));

  try {
    const info = await handle.stat();

    if (!info.isFile()) {
      throw new Error(`Not a regular file: ${display}`);
    }

    if (info.size > MAX_FILE_BYTES) {
      throw new Error(
        `File too large (${info.size} bytes > ${MAX_FILE_BYTES}): ${display}. Pass a line range such as \`${display}#L1-500\`.`,
      );
    }

    const text = await handle.readFile("utf8");

    if (text.includes(String.fromCharCode(0))) {
      throw new Error(`Binary file is not supported: ${display}`);
    }

    const all = text.replace(/\r\n/g, "\n").split("\n");

    const from = start ? Math.min(start, all.length) : 1;

    const to = end === undefined ? all.length : Math.min(end, all.length);

    const lines = all.slice(from - 1, to);

    const where = start ? `(lines ${from}-${to} of ${all.length})` : `(${all.length} lines)`;

    return {
      display,

      label: `### File: ${display} ${where}`,

      body: lineNumbers ? numberLines(lines, from) : lines.join("\n"),

      extension: path.posix.extname(toUnix(display)).slice(1),
    };
  } finally {
    await handle.close();
  }
}

// inline_files の名前は Claude が自由に決めるため、そのまま見出しに置くと
// 改行やバッククォートでフェンスを閉じ、別のファイルの中身に見せかけられる。
// 1 行に潰し、制御文字と書式制御の文字を落とす
export function safeName(name) {
  const flat = String(name)
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/[`#]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return flat.slice(0, 120) || "inline";
}

function inlinePart({ name, content }, { lineNumbers }) {
  const display = safeName(name);

  const text = String(content ?? "");

  if (text.includes(String.fromCharCode(0))) {
    throw new Error(`Binary content is not supported: ${display}`);
  }

  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .split("\n");

  return {
    display,

    label: `### Inline file: ${display} (${lines.length} lines)`,

    body: lineNumbers ? numberLines(lines) : lines.join("\n"),

    extension: path.posix.extname(display).slice(1),
  };
}

function render(part) {
  const fence = fenceFor(part.body);

  return `${part.label}\n${fence}${part.extension}\n${part.body}\n${fence}`;
}

// 1 件も入らないときの最後の手段。先頭のファイルを入るところまで入れ、切ったことを本文に書く。
// 空の文脈で答えさせると、読んでいないのに「指摘なし」と返ってくるため、空にはしない
function renderTruncated(part, budget) {
  const lines = part.body.split("\n");

  const kept = [];

  // ラベルとフェンスと打ち切りの但し書きの分を先に引いておく
  let used = estimateTokens(part.label) + 32;

  for (const line of lines) {
    const tokens = estimateTokens(line) + 1;

    if (used + tokens > budget) {
      break;
    }

    kept.push(line);

    used += tokens;
  }

  const body = `${kept.join("\n")}\n... [truncated: kept ${kept.length} of ${lines.length} lines]`;

  const fence = fenceFor(body);

  return `${part.label}\n${fence}${part.extension}\n${body}\n${fence}`;
}

/**
 * files と inline_files をまとめて、ローカルのモデルに渡すブロックに整える。
 * トークン数の目安で予算を共有し、入りきらないファイルは丸ごと落として notes に残す。
 */
export async function buildFileContext({
  files = [],
  inlineFiles = [],
  lineNumbers = false,
  signal,
} = {}) {
  if (files.length > 0 && readRoots().length === 0) {
    throw new Error("File access is disabled on this server (FILE_ROOTS is not set)");
  }

  const targets = [];

  for (const input of files) {
    signal?.throwIfAborted();

    targets.push(...(await resolveItem(input, signal)));
  }

  // グロブと明示的なパスが重なると同じ中身を 2 回渡すことになるため、実際のパスで重複を落とす。
  // 先に書かれたほうを残す
  const seen = new Set();

  const unique = targets.filter((target) => {
    const key = `${target.local}#${target.start ?? ""}-${target.end ?? ""}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });

  const blocks = [];

  const omitted = [];

  let used = 0;

  let first;

  for (const target of unique) {
    signal?.throwIfAborted();

    // 予算を使い切ったあとは読まない。読んでから捨てると、40 件 x 512 KB を無駄に読むことになる
    if (used >= MAX_PROMPT_TOKENS && first) {
      omitted.push(target.display);

      continue;
    }

    const part = await readPart(target, { lineNumbers });

    first ??= part;

    const text = render(part);

    const tokens = estimateTokens(text);

    if (used + tokens > MAX_PROMPT_TOKENS) {
      omitted.push(part.display);

      continue;
    }

    used += tokens;

    blocks.push(text);
  }

  for (const inline of inlineFiles) {
    const part = inlinePart(inline, { lineNumbers });

    first ??= part;

    const text = render(part);

    const tokens = estimateTokens(text);

    if (used + tokens > MAX_PROMPT_TOKENS) {
      omitted.push(part.display);

      continue;
    }

    used += tokens;

    blocks.push(text);
  }

  const notes = [];

  if (blocks.length === 0 && first) {
    blocks.push(renderTruncated(first, MAX_PROMPT_TOKENS));

    omitted.shift();

    notes.push(
      `WARNING: ${first.display} did not fit the input budget (${MAX_PROMPT_TOKENS} tokens) and was cut off. Pass a line range such as \`path#L1-500\`.`,
    );
  }

  if (omitted.length > 0) {
    notes.push(
      `WARNING: ${omitted.length} of ${unique.length + inlineFiles.length} files were omitted because the input budget (${MAX_PROMPT_TOKENS} tokens) was reached: ${omitted.join(", ")}. Split them across several calls.`,
    );
  }

  return { block: blocks.join("\n\n"), notes, usedTokens: used };
}

/**
 * 1 つのファイルの中身を読む。resources/read と read_file が使う。
 * 防御は files 引数とまったく同じ経路（resolvePath と readBlock）を通す。
 */
export async function readOneFile(input, { lineNumbers = false } = {}) {
  if (readRoots().length === 0) {
    throw new Error("File access is disabled on this server (FILE_ROOTS is not set)");
  }

  const [target] = await resolveItem(input);

  return render(await readPart(target, { lineNumbers }));
}

/**
 * resources/read が使う。ディレクトリなら一覧を、ファイルなら中身を返す。
 * 防御は files 引数とまったく同じ resolvePath と readPart を通す。
 */
export async function readForResource(input, { signal } = {}) {
  if (readRoots().length === 0) {
    throw new Error("File access is disabled on this server (FILE_ROOTS is not set)");
  }

  const range = splitLineRange(input);

  let resolved;

  try {
    resolved = await resolvePath(range.path);
  } catch (error) {
    if (range.path === input) {
      throw error;
    }

    resolved = await resolvePath(input);
  }

  if ((await stat(resolved.local)).isDirectory()) {
    return await listFiles({ path: range.path, signal });
  }

  return await readOneFile(input);
}

export { toHostPath };
