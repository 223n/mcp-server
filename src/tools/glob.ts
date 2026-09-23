// list_files のグロブの照合。
// 正規表現に変換すると、* を並べたパターンでバックトラックが爆発し、サーバー全体が止まる（ReDoS）。
// そのため、パスを「/」ごとの段に分けて照合する。
// 段の中の照合（* と ?）も、** を含む段の並びの照合も、長さの積に比例する時間で終わる。

/** compileGlob が返す照合器。maxDepth は当たりうる最も深い段の数（`**` があれば Infinity） */
export type GlobMatcher = {
  dirOnly: boolean;
  maxDepth: number;
  test: (relativePath: string, isDirectory: boolean) => boolean;
};

const MAX_ALTERNATIVES = 32;

// "*.{js,ts}" を "*.js" と "*.ts" に展開する。入れ子には対応しない
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");

  if (open < 0) {
    return [pattern];
  }

  const close = pattern.indexOf("}", open);

  if (close < 0) {
    throw new Error("Unbalanced `{` in pattern");
  }

  const options = pattern.slice(open + 1, close).split(",");

  if (options.some((option) => option.includes("{"))) {
    throw new Error("Nested `{}` is not supported in pattern");
  }

  const head = pattern.slice(0, open);

  const tails = expandBraces(pattern.slice(close + 1));

  const results: string[] = [];

  for (const option of options) {
    for (const tail of tails) {
      results.push(head + option + tail);

      if (results.length > MAX_ALTERNATIVES) {
        throw new Error(`Pattern expands to more than ${MAX_ALTERNATIVES} alternatives`);
      }
    }
  }

  return results;
}

// 1段の中の照合。* は0文字以上、? は1文字に当たる。最後の * の位置へだけ戻る方式で、戻りは爆発しない
export function matchSegment(pattern: string, text: string): boolean {
  let p = 0;

  let t = 0;

  let star = -1;

  let mark = 0;

  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p += 1;

      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;

      p += 1;

      mark = t;
    } else if (star >= 0) {
      p = star + 1;

      mark += 1;

      t = mark;
    } else {
      return false;
    }
  }

  while (pattern[p] === "*") {
    p += 1;
  }

  return p === pattern.length;
}

// 段の並びの照合。** は0段以上に当たる。結果を覚えておくため、組み合わせの数より多くは計算しない
function matchSegments(patternSegments: string[], pathSegments: string[]): boolean {
  const memo = new Map<number, boolean>();

  const width = pathSegments.length + 1;

  const go = (i: number, j: number): boolean => {
    const key = i * width + j;

    const cached = memo.get(key);

    if (cached !== undefined) {
      return cached;
    }

    let result: boolean;

    if (i === patternSegments.length) {
      result = j === pathSegments.length;
    } else if (patternSegments[i] === "**") {
      result = go(i + 1, j) || (j < pathSegments.length && go(i, j + 1));
    } else {
      // i と j はどちらも長さ未満だと確かめた上で取り出すため、実際には undefined にならない
      result =
        j < pathSegments.length &&
        matchSegment(patternSegments[i] ?? "", pathSegments[j] ?? "") &&
        go(i + 1, j + 1);
    }

    memo.set(key, result);

    return result;
  };

  return go(0, 0);
}

// パターンを照合用の形にする。大文字と小文字は区別しない（Windows のファイル名に合わせる）。
// 末尾の「/」はディレクトリだけに当てる。maxDepth は当たりうる最も深い段の数（** があれば上限なし）
export function compileGlob(pattern: string): GlobMatcher {
  let source = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");

  const dirOnly = source.endsWith("/");

  source = source.replace(/\/+$/, "") || "*";

  if (source.startsWith("/") || source.split("/").includes("..")) {
    throw new Error("`pattern` must be relative to `path` and must not contain `..`");
  }

  const alternatives = expandBraces(source).map((alternative) =>
    alternative
      .toLowerCase()
      .split("/")
      .filter(Boolean)
      .map((segment) => (/^\*{2,}$/.test(segment) ? "**" : segment.replace(/\*{2,}/g, "*")))
      .filter((segment, index, all) => !(segment === "**" && all[index - 1] === "**")),
  );

  const maxDepth = alternatives.some((segments) => segments.includes("**"))
    ? Number.POSITIVE_INFINITY
    : Math.max(...alternatives.map((segments) => segments.length));

  return {
    dirOnly,

    maxDepth,

    test(relativePath: string, isDirectory: boolean): boolean {
      if (dirOnly && !isDirectory) {
        return false;
      }

      const segments = relativePath.toLowerCase().split("/");

      return alternatives.some((alternative) => matchSegments(alternative, segments));
    },
  };
}
