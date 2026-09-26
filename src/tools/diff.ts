/**
 * 差分をローカルのモデルに渡す形に整える。ollama_review_code の git_diff と pull_request が使う。
 *
 * 小さいモデルに "@@ -10,7 +12,9 @@" から行番号を数えさせると外れる。
 * numberLines と同じく、サーバーが新しいファイルでの行番号を振ってから渡す。
 */

import type { ContextSection } from "../types.ts";

import { safeName } from "./files.ts";

import { DIFF_HEADER, headerPaths, splitDiffSections, unquotePath } from "./sensitive.ts";

// "@@ -10,7 +12,9 @@ 関数名" の、新しいファイルの側の開始行
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// 見出しのうち、モデルに見せても役に立たない行。パスは見出しの 1 行に出す
const NOISE = /^(index |--- |\+\+\+ )/;

// inline_files と同じく、制御文字と書式制御の文字を落とす。
// 他人の書いたコードなので、双方向の制御文字で見た目と中身を食い違わせる細工（Trojan Source）がありうる
function clean(line: string): string {
  return line
    .replace(/\r$/, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, "");
}

// 表示用に、git が付ける "a/" と "b/" を外す
function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

// 区画のファイルの名前。新しい名前を優先し、消したファイルなら元の名前を使う
function sectionName(section: string[]): { name: string; renamedFrom?: string } {
  let newPath: string | undefined;

  let oldPath: string | undefined;

  let renamedFrom: string | undefined;

  for (const line of section) {
    if (line.startsWith("@@")) {
      break;
    }

    // 名前に空白を含むと、git は "--- " と "+++ " の行の末尾にタブを足す
    const value = (prefix: string) => unquotePath(line.slice(prefix.length).replace(/\t.*$/, ""));

    if (line.startsWith("+++ ")) {
      newPath ??= value("+++ ");
    } else if (line.startsWith("--- ")) {
      oldPath ??= value("--- ");
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      newPath ??= value(line.startsWith("rename to ") ? "rename to " : "copy to ");
    } else if (line.startsWith("rename from ")) {
      renamedFrom = value("rename from ");
    }
  }

  const header = section[0] !== undefined && DIFF_HEADER.test(section[0]) ? headerPaths(section[0]).at(-1) : undefined;

  const name = [newPath, oldPath, header].find((p) => p !== undefined && p !== "/dev/null") ?? "(unknown)";

  return { name: stripPrefix(name), renamedFrom: renamedFrom === undefined ? undefined : stripPrefix(renamedFrom) };
}

type Row = { number?: number; text: string };

function numberSection(section: string[]): ContextSection | undefined {
  const { name, renamedFrom } = sectionName(section);

  const meta: string[] = [];

  const rows: Row[] = [];

  // 次の行の、新しいファイルでの行番号
  let next = 0;

  // 最初の "@@" を過ぎたか。その前は見出し
  let inBody = false;

  // 行番号を振るか。マージの差分（"@@@"）は、どの親の行番号を振るかが決まらないため、振らずにそのまま渡す。
  // "@@" の書式が読めないときも振らない。外れた番号を渡すより、番号が無いほうがよい
  let numbered = true;

  for (const [index, raw] of section.entries()) {
    const line = clean(raw);

    if (index === 0 && DIFF_HEADER.test(line)) {
      numbered = line.startsWith("diff --git ");

      continue;
    }

    // 差分の末尾の改行を split した名残
    if (line === "" && index === section.length - 1) {
      continue;
    }

    const hunk = HUNK.exec(line);

    if (!inBody && !line.startsWith("@@")) {
      // 新しいファイル、消したファイル、名前の変更、バイナリを伝える行だけを残す
      if (line !== "" && !NOISE.test(line)) {
        meta.push(line);
      }

      continue;
    }

    if (!inBody) {
      inBody = true;

      numbered &&= hunk?.[1] !== undefined;
    }

    if (!numbered) {
      rows.push({ text: line });

      continue;
    }

    if (hunk?.[1] !== undefined) {
      next = Number(hunk[1]);

      rows.push({ text: line });
    } else if (line.startsWith("+")) {
      rows.push({ number: next, text: line });

      next += 1;
    } else if (line.startsWith("-") || line.startsWith("\\")) {
      // 消した行と「\ No newline at end of file」は、新しいファイルに無いため番号を空ける
      rows.push({ text: line });
    } else {
      // 文脈の行。空白を落とす道具を通った差分では、空行の先頭の " " が消えていることがある
      rows.push({ number: next, text: line.startsWith(" ") ? line : ` ${line}` });

      next += 1;
    }
  }

  if (rows.length === 0 && meta.length === 0) {
    return undefined;
  }

  const width = String(Math.max(0, ...rows.map((row) => row.number ?? 0))).length;

  const body = [
    ...meta,
    ...rows.map((row) =>
      row.text.startsWith("@@") || !numbered
        ? row.text
        : `${row.number === undefined ? " ".repeat(width) : String(row.number).padStart(width)}|${row.text}`,
    ),
  ].join("\n");

  const display = safeName(name);

  const notes = [
    renamedFrom !== undefined && renamedFrom !== name ? `renamed from ${safeName(renamedFrom)}` : "",
    inBody && !numbered ? "lines not numbered" : "",
  ].filter(Boolean);

  return {
    display,

    label: `### Diff: ${display}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`,

    body,

    extension: "diff",
  };
}

/**
 * unified diff を、ファイルごとの区画に分けて行番号を振る。
 *
 * 追加行（+）と文脈の行（空白）に新しいファイルでの行番号を振り、消した行（-）は番号を空ける。
 * 秘密のファイルは、呼び出す側が excludeSensitiveSections で先に落としておくこと
 */
export function numberDiff(diff: string): ContextSection[] {
  return splitDiffSections(diff)
    .map(numberSection)
    .filter((section): section is ContextSection => section !== undefined);
}
