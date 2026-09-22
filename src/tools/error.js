import { config } from "../config/config.js";

import { runChat } from "./ollama.js";

export async function ollamaExplainError(args, ctx) {
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

      lineNumbers: true,

      temperature: 0.2,

      maxTokens: args.max_tokens ?? 1536,
    },
    ctx,
  );
}
