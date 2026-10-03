import type { ContextSection, InlineFile, ShownPart, ToolContext, ToolResult } from "../types.ts";

import type { GitDiffSource } from "./git.ts";

import type { PullRequestSource } from "./github.ts";

import { config } from "../config/config.ts";

import { SYSTEM_PROMPTS } from "../config/prompts.ts";

import { numberDiff } from "./diff.ts";

import { checkFindings, FINDINGS_SCHEMA } from "./findings.ts";

import { fenceFor, numberLines } from "./files.ts";

import { readCloneDiff } from "./git.ts";

import { readPullDiff } from "./github.ts";

import { runChatOrJob } from "./ollama.ts";

function codeBlock(code: string): string {
  const body = numberLines(code.replace(/\r\n/g, "\n").split("\n"));

  const fence = fenceFor(body);

  return `\nコード:\n\n${fence}\n${body}\n${fence}`;
}

/** ollama_review_code の引数。src/tools/index.ts の inputSchema と対で保つこと */
export type ReviewCodeArgs = {
  code?: string;
  files?: string[];
  inline_files?: InlineFile[];
  git_diff?: GitDiffSource;
  pull_request?: PullRequestSource;
  line_numbers?: boolean;
  save_output?: boolean;
  output_name?: string;
  background?: boolean;
  structured?: boolean;
  language?: string;
  focus?: string;
  model?: string;
  max_tokens?: number;
};

// 差分を読み、ファイルごとの区画に分けて行番号を振る。
// 差分は Claude に返さず、ローカルのモデルにだけ渡す。Claude が読んで写す往復を省くため
async function diffSections(
  args: ReviewCodeArgs,
  signal?: AbortSignal,
): Promise<{ sections: ContextSection[]; notes: string[]; source?: string }> {
  if (args.git_diff && args.pull_request) {
    throw new Error("Pass either `git_diff` or `pull_request`, not both");
  }

  const read = args.git_diff
    ? await readCloneDiff(args.git_diff, signal)
    : args.pull_request
      ? await readPullDiff(args.pull_request, signal)
      : undefined;

  if (!read) {
    return { sections: [], notes: [] };
  }

  const source = args.git_diff
    ? `${args.git_diff.repo} の差分`
    : `${args.pull_request?.repo}#${args.pull_request?.number} の差分`;

  const sections = numberDiff(read.text);

  if (sections.length === 0) {
    // 差分が空のときは呼ばない。空の文脈で答えさせると、読んでいないのに「指摘なし」と返ってくる
    throw new Error(
      `The diff is empty${read.notes.length > 0 ? ` (${read.notes.join(" ")})` : ""}. Check \`ref\` and \`staged\`, or the pull request number.`,
    );
  }

  return { sections, notes: read.notes, source };
}

export async function ollamaReviewCode(
  args: ReviewCodeArgs,
  ctx?: ToolContext,
): Promise<ToolResult> {
  if (
    !args.code &&
    !args.files?.length &&
    !args.inline_files?.length &&
    !args.git_diff &&
    !args.pull_request
  ) {
    throw new Error("Either `code`, `files`, `inline_files`, `git_diff` or `pull_request` is required");
  }

  const diff = await diffSections(args, ctx?.mcpReq?.signal);

  // 差分を渡すときは、指摘の場所を「ファイル:行」にする。
  // 行番号は新しいファイルでの番号で、サーバーが振ってある。消した行には番号が無い
  const location = diff.source
    ? `- 場所は「ファイル:行」の形で書く（例: src/app.ts:42）。行は差分の左側に付いている番号（新しいファイルでの行番号）を使う
- 番号の無い行（- で始まる消した行）を指すときは、そのすぐ下の番号の付いた行を使う`
    : "- 行番号はコードの左側に付いている番号を使う";

  // 根拠の無い候補を「可能性がある」と書いて残させない。
  // 起きる条件を考えさせ、示せない候補と、コードがすでに対処している候補を捨てさせる
  const steps = `進め方:
1. ${diff.source ? "変わった行（+ の行）が何をするのかを、文脈の行（先頭が空白）も使って理解する" : "コードが何をするのかを理解する"}
2. 不具合の候補ごとに、それが実際に起きる具体的な入力や状態を考える。示せない候補は捨てる
3. 候補の行と前後を読み直し、コードがすでに対処していないかを確かめる。対処していれば捨てる`;

  const textFormat = `出力形式:
- 指摘ごとに「[重大度: 高/中/低] ${diff.source ? "ファイル:行" : "行番号"}: 問題（起きる条件: 入力や状態と、そのとき何が起きるか） → 改善案」の形で箇条書きにする
${location}
- 指摘は重要なものから最大 5 件まで
- 修正後のコード全体は出力しない（改善案は該当箇所の短いコード片だけにする）
- 問題がなければ「指摘なし」とだけ書く`;

  // structured では JSON で受け、渡していないファイルや行を指す指摘をサーバーで落とす。
  // evidence（問題の行の写し）を書かせると、モデルがその行を読み直してから答える
  const jsonFormat = `出力形式:
- JSON だけで答える。形は {"findings": [{"file": 名前, "line": 行番号, "severity": "high" か "medium" か "low", "evidence": 問題の行の写し, "scenario": 問題が起きる入力や状態, "problem": 問題, "fix": 改善案}]}
- file には、見出し（### File:、### Inline file:、### Diff:）に書かれた名前をそのまま書く。「コード:」の下のコードは "code" と書く
- line には、左側に付いている番号を使う。番号の無い行（- で始まる消した行）を指すときは、そのすぐ下の番号の付いた行を使う
- evidence には、問題の行のコードを入力から一字一句そのまま写す（左側の番号と | と +- の記号は含めない）
- scenario には、問題が起きる具体的な入力や状態と、そのとき何が起きるかを書く
- 指摘は重要なものから最大 5 件まで
- fix には該当箇所の短いコード片か説明だけを書く（修正後のコード全体は書かない）
- 問題がなければ findings を空の配列にする`;

  // 観点はそのまま指摘に言い換えられやすい。見る場所の手がかりとして渡し、無ければ書かない。
  // 何を報告するかはシステムプロンプト（SYSTEM_PROMPTS.code_review）が決める
  const focus = args.focus
    ? `特に気を付ける観点: ${args.focus}\n（観点は見る場所の手がかりです。観点ごとに指摘を作る必要はありません）\n`
    : "";

  const prompt = `
以下の${diff.source ?? "コード"}をレビューしてください。

言語: ${args.language ?? "（ファイル拡張子から判断）"}
${focus}
${steps}

${args.structured ? jsonFormat : textFormat}
${args.code ? codeBlock(args.code) : ""}
`;

  // code 引数のコードは、ファイルとは別に「code」という名前で 1 行目から渡している
  const codeLines = args.code ? args.code.replace(/\r\n/g, "\n").split("\n").length : 0;

  return await runChatOrJob(
    "ollama_review_code",
    args,
    {
      model: args.model ?? config.deepModel,

      system: SYSTEM_PROMPTS.code_review,

      prompt,

      files: args.files,

      inlineFiles: args.inline_files,

      sections: diff.sections,

      sectionNotes: diff.notes,

      lineNumbers: true,

      temperature: 0.2,

      maxTokens: args.max_tokens ?? 1536,

      save: args.save_output ?? false,

      outputName: args.output_name,

      ...(args.structured
        ? {
            format: FINDINGS_SCHEMA,

            postProcess: (content: string, shown: ShownPart[]) =>
              checkFindings(content, codeLines > 0 ? [{ name: "code", ranges: [[1, codeLines]] }, ...shown] : shown),
          }
        : {}),
    },
    ctx,
  );
}
