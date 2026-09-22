import { config } from "../config/config.js";

import { SYSTEM_PROMPTS } from "../config/prompts.js";

import { fenceFor, numberLines } from "./files.js";

import { runChat } from "./ollama.js";

function codeBlock(code) {
  const body = numberLines(code.replace(/\r\n/g, "\n").split("\n"));

  const fence = fenceFor(body);

  return `\nコード:\n\n${fence}\n${body}\n${fence}`;
}

export async function ollamaReviewCode(args, ctx) {
  if (!args.code && !args.files?.length) {
    throw new Error("Either `code` or `files` is required");
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

      lineNumbers: true,

      temperature: 0.2,

      maxTokens: args.max_tokens ?? 1536,
    },
    ctx,
  );
}
