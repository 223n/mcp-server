import type { InlineFile, ToolContext, ToolResult } from "../types.ts";

import { config } from "../config/config.ts";

import { runChat } from "./ollama.ts";

/** ollama_explain_error の引数。src/tools/index.ts の inputSchema と対で保つこと */
export type ExplainErrorArgs = {
  error: string;
  context?: string;
  files?: string[];
  inline_files?: InlineFile[];
  line_numbers?: boolean;
  save_output?: boolean;
  output_name?: string;
  model?: string;
  max_tokens?: number;
};

export async function ollamaExplainError(
  args: ExplainErrorArgs,
  ctx?: ToolContext,
): Promise<ToolResult> {
  const prompt = `
以下のエラーを解析してください。
原因の候補を可能性の高い順に挙げ、それぞれの確認方法と対処法を示してください。

エラー:

${args.error}
${args.context ? `\n補足情報:\n\n${args.context}` : ""}
`;

  return await runChat(
    {
      model: args.model ?? config.deepModel,

      system: "あなたはエラー解析専門家です。",

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
