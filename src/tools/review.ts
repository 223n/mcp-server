import type { ContextSection, InlineFile, ToolContext, ToolResult } from "../types.ts";

import type { GitDiffSource } from "./git.ts";

import type { PullRequestSource } from "./github.ts";

import { config } from "../config/config.ts";

import { SYSTEM_PROMPTS } from "../config/prompts.ts";

import { numberDiff } from "./diff.ts";

import { fenceFor, numberLines } from "./files.ts";

import { readCloneDiff } from "./git.ts";

import { readPullDiff } from "./github.ts";

import { runChat } from "./ollama.ts";

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
- 番号の無い行（- で始まる消した行）を指すときは、そのすぐ下の番号の付いた行を使う
- 変わった行（+ と - の行）を中心に見る。文脈の行（先頭が空白）は理解のためだけに使う`
    : "- 行番号はコードの左側に付いている番号を使う";

  const prompt = `
以下の${diff.source ?? "コード"}をレビューしてください。

言語: ${args.language ?? "（ファイル拡張子から判断）"}
重点: ${args.focus ?? "バグ、セキュリティ、保守性、パフォーマンス"}

出力形式:
- 指摘ごとに「[重大度: 高/中/低] ${diff.source ? "ファイル:行" : "行番号"}: 問題 → 改善案」の形で箇条書きにする
${location}
- 確信が持てない指摘には「要確認」と付ける
- 指摘は重要なものから最大 10 件まで
- 修正後のコード全体は出力しない（改善案は該当箇所の短いコード片だけにする）
- 問題がなければ「指摘なし」とだけ書く
${args.code ? codeBlock(args.code) : ""}
`;

  return await runChat(
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
    },
    ctx,
  );
}
