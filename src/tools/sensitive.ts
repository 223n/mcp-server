/**
 * 秘密を含みやすいファイルとディレクトリの判定。
 *
 * files.ts（files、list_files、read_file、resources/read）、git.ts の diff、github.ts の pr_diff が
 * どれもここを使う。入口ごとに一覧を持つと、片方に足した規則がもう片方に伝わらず、
 * files では読めない秘密が diff からは読める、という抜け道になる。
 */

// 秘密情報を含みやすいファイル名（大文字小文字は区別しない）
export const SENSITIVE_FILES = [
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
export const SENSITIVE_DIRS = /^(\.(ssh|aws|azure|gcloud|gnupg|docker|kube|git|cloudflared|wrangler|terraform)|secrets?)$/i;

/**
 * パスの 1 段が秘密に当たるか。
 *
 * ファイルの拒否リストとディレクトリの拒否リストの両方で判定する。
 * 「最後の段はファイルだから SENSITIVE_FILES だけ」にすると、ディレクトリを渡したときに
 * .ssh や .kube や secrets が通り、逆に「ディレクトリだから SENSITIVE_DIRS だけ」にすると .env が通る
 */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_DIRS.test(name) || SENSITIVE_FILES.some((pattern) => pattern.test(name));
}

/** パスのどれかの段が秘密に当たるか。区切りは "/" と "\" のどちらでもよい */
export function isSensitivePath(input: string): boolean {
  return input.split(/[\\/]/).some((part) => part !== "" && isSensitiveName(part));
}

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * git が引用符で囲んだパス（"a/\343\201\202/.env" など）を元の文字列に戻す。
 * 日本語の名前や制御文字を含む名前は、8 進数のバイト列に書き換えられて届く
 */
export function unquotePath(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) {
    return text;
  }

  const bytes: number[] = [];

  const body = text.slice(1, -1);

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? "";

    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));

      continue;
    }

    const next = body[i + 1] ?? "";

    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));

    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));

      i += 3;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));

      i += 1;
    }
  }

  return Buffer.from(bytes).toString("utf8");
}

// 区画の始まり。マージの差分（--cc、--combined）も区画として扱い、前の区画に紛れ込ませない
export const DIFF_HEADER = /^diff --(git|cc|combined) /;

const HEADER = DIFF_HEADER;

// 引用符で始まる文字列の、閉じる引用符の位置。"\"" は閉じる引用符として数えない
function closingQuote(text: string): number {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
    } else if (text[i] === '"') {
      return i;
    }
  }

  return -1;
}

// "diff --git a/x b/y" の x と y の候補を返す。
// 引用符が無く名前に空白を含むと区切りが一意に決まらないため、候補をすべて返す。
// 判定は安全側（どれか 1 つでも当たれば外す）に倒す
export function headerPaths(line: string): string[] {
  const rest = line.replace(HEADER, "");

  if (rest.startsWith('"')) {
    const end = closingQuote(rest);

    return end > 0
      ? [unquotePath(rest.slice(0, end + 1)), unquotePath(rest.slice(end + 2))]
      : [unquotePath(rest)];
  }

  const paths: string[] = [];

  for (const separator of [" b/", ' "b/']) {
    for (let i = rest.indexOf(separator); i >= 0; i = rest.indexOf(separator, i + 1)) {
      paths.push(rest.slice(0, i), unquotePath(rest.slice(i + 1)));
    }
  }

  return paths.length > 0 ? paths : [rest];
}

// 区画の見出しの部分（最初の @@ より前）から、ファイルのパスを集める。
// 本文にも "--- " で始まる行（"-- " を消した行）が現れるため、見出しの外は読まない
function sectionPaths(section: string[]): string[] {
  const paths: string[] = [];

  for (const [index, line] of section.entries()) {
    if (index === 0 && HEADER.test(line)) {
      paths.push(...headerPaths(line));

      continue;
    }

    // "@@ " は通常の差分、"@@@ " はマージの差分の本文の始まり
    if (line.startsWith("@@")) {
      break;
    }

    const named = /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/.exec(line);

    if (named?.[1] !== undefined) {
      // 名前に空白を含むと、git は "--- " と "+++ " の行の末尾にタブを足す
      paths.push(unquotePath(named[1].replace(/\t.*$/, "")));
    }
  }

  return paths.filter((p) => p !== "/dev/null");
}

// 表示用に、git が付ける "a/" と "b/" を外す
function displayPath(p: string): string {
  return p.replace(/^[ab]\//, "");
}

/**
 * unified diff を区画（"diff --git" から次の "diff --git" の手前まで）に分ける。
 * 最初の見出しより前の行（空行など）は、先頭の区画になる
 */
export function splitDiffSections(diff: string): string[][] {
  const sections: string[][] = [];

  let section: string[] = [];

  for (const line of diff.split("\n")) {
    if (HEADER.test(line) && section.length > 0) {
      sections.push(section);

      section = [];
    }

    section.push(line);
  }

  sections.push(section);

  return sections;
}

/**
 * unified diff から、秘密のファイルに当たる区画を落とす。
 * 名前を変えた区画は、元の名前と新しい名前のどちらかが当たれば落とす
 */
export function excludeSensitiveSections(diff: string): { text: string; excluded: string[] } {
  const kept: string[] = [];

  const excluded: string[] = [];

  for (const section of splitDiffSections(diff)) {
    const hit = sectionPaths(section).find((p) => isSensitivePath(p));

    if (hit === undefined) {
      kept.push(...section);
    } else if (!excluded.includes(displayPath(hit))) {
      excluded.push(displayPath(hit));
    }
  }

  return { text: kept.join("\n"), excluded };
}

/** 落としたファイルがあったことを、応答の末尾に書き添える文 */
export function exclusionNote(excluded: string[]): string {
  if (excluded.length === 0) {
    return "";
  }

  return `[excluded ${excluded.length} file(s) that may contain secrets: ${excluded.join(", ")}]`;
}
