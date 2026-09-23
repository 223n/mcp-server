import type { InlineFile, ToolContext, ToolResult } from "../types.ts";

import { config } from "../config/config.ts";

import { SYSTEM_PROMPTS } from "../config/prompts.ts";

import { fenceFor, numberLines } from "./files.ts";

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
  line_numbers?: boolean;
  save_output?: boolean;
  output_name?: string;
  language?: string;
  focus?: string;
  model?: string;
  max_tokens?: number;
};

export async function ollamaReviewCode(
  args: ReviewCodeArgs,
  ctx?: ToolContext,
): Promise<ToolResult> {
  if (!args.code && !args.files?.length && !args.inline_files?.length) {
    throw new Error("Either `code`, `files` or `inline_files` is required");
  }

  const prompt = `
以下のコードをレビューしてください。

言語: ${args.language ?? "（ファイル拡張子から判断）"}
重点: ${args.focus ?? "バグ、セキュリティ、保守性、パフォーマンス"}

出力形式:
- 指摘ごとに「[重大度: 高/中/低] 行番号: 問題 → 改善案」の形で箇条書きにする
- 行番号はコードの左側に付いている番号を使う
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

      lineNumbers: true,

      temperature: 0.2,

      maxTokens: args.max_tokens ?? 1536,

      save: args.save_output ?? false,

      outputName: args.output_name,
    },
    ctx,
  );
}
