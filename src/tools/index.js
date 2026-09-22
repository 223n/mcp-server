import * as z from "zod";

import { config } from "../config/config.js";

import { SYSTEM_PROMPTS } from "../config/prompts.js";

import { ollamaExplainError } from "./error.js";

import { fileRootsLabel, listFiles } from "./files.js";

import { createHealthTool } from "./health.js";

import { ollamaChatTool, ollamaListModels } from "./ollama.js";

import { ollamaReviewCode } from "./review.js";

const READ_ONLY = {
  readOnlyHint: true,

  destructiveHint: false,

  idempotentHint: false,

  openWorldHint: false,
};

const maxTokensArg = (fallback) =>
  z
    .number()
    .int()
    .positive()
    .max(16384)
    .optional()
    .describe(`Upper bound on generated tokens (Ollama num_predict). Default ${fallback}.`);

const modelArg = (fallback) =>
  z
    .string()
    .max(200)
    .optional()
    .describe(
      `Ollama model name. Default: ${fallback}. "nucbox-fast:latest" (qwen2.5-coder 7B) is quicker; "qwen2.5-coder:14b" (= nucbox-deep) is stronger. Call ollama_list_models for the full list.`,
    );

export function buildTools({ allowFiles }) {
  const filesEnabled = allowFiles && config.fileRoots.length > 0;

  const filesArg = filesEnabled
    ? {
        files: z
          .array(z.string().max(1024))
          .max(20)
          .optional()
          .describe(
            `Absolute file paths to include (Windows or container paths under: ${fileRootsLabel()}). The server reads them, so do not paste file contents yourself. Max ~90k characters in total.`,
          ),
      }
    : {};

  const filesHint = filesEnabled
    ? ` Prefer passing \`files\` (paths under ${fileRootsLabel()}) over pasting contents: it saves Claude tokens.`
    : "";

  const fileTools = filesEnabled
    ? [
        {
          name: "list_files",

          title: "Files: list files under the allowed roots",

          description:
            `List files and directories under ${fileRootsLabel()} on the machine that runs Ollama, so their paths can be passed to the \`files\` argument of the Ollama tools. ` +
            "Call it without `path` to get the roots. Secret files and dependency folders (node_modules, vendor, .git) are hidden, symlinks are skipped, and `**` searches at most 8 levels below `path`. Read-only.",

          inputSchema: z.strictObject({
            path: z
              .string()
              .max(1024)
              .optional()
              .describe("Directory to list (absolute Windows path under an allowed root). Omit to list the roots."),

            pattern: z
              .string()
              .max(200)
              .optional()
              .describe("Glob relative to `path`, case-insensitive: `*` = direct children (default), `**/*.php` = PHP files below, `src/**` = everything under src, `*.{js,ts}` = alternatives, trailing `/` = directories only."),

            max_entries: z
              .number()
              .int()
              .positive()
              .max(1000)
              .optional()
              .describe("Maximum number of entries to return. Default 200."),
          }),

          annotations: { ...READ_ONLY, idempotentHint: true },

          handler: (args, ctx) =>
            listFiles({
              path: args.path,

              pattern: args.pattern,

              maxEntries: args.max_entries,

              signal: ctx?.mcpReq?.signal,
            }),
        },
      ]
    : [];

  return [
    {
      name: "ollama_chat",

      title: "Ollama: chat / delegate a task",

      description:
        "Delegate a self-contained text task to a local LLM running on the user's own GPU via Ollama (no API cost, private). " +
        "Good for first drafts, summaries, translations, boilerplate, test scaffolding, brainstorming and bulk text processing. " +
        "The local model (qwen2.5-coder 7B/14B, 32k context) is much weaker than Claude: give it complete context in one prompt and verify its output before relying on it. " +
        "Typical latency 5-90 s." +
        filesHint,

      inputSchema: z.strictObject({
        prompt: z.string().min(1).max(200000).describe("The full instruction for the local model."),

        model: modelArg(config.defaultModel),

        profile: z
          .enum(Object.keys(SYSTEM_PROMPTS))
          .optional()
          .describe("Preset system prompt (ignored when `system` is given)."),

        system: z.string().max(20000).optional().describe("Custom system prompt."),

        ...filesArg,

        ...(filesEnabled
          ? {
              line_numbers: z
                .boolean()
                .optional()
                .describe("Prefix file lines with line numbers (default false)."),
            }
          : {}),

        temperature: z.number().min(0).max(2).optional().describe("Default 0.7."),

        max_tokens: maxTokensArg(4096),
      }),

      annotations: READ_ONLY,

      handler: ollamaChatTool,
    },

    {
      name: "ollama_review_code",

      title: "Ollama: code review",

      description:
        "Get a second-opinion code review from the local LLM (default qwen2.5-coder 14B). " +
        "Returns findings as '[severity] line: problem -> fix'. Findings are often wrong or shallow: treat them as leads and confirm each one in the source before reporting." +
        filesHint,

      inputSchema: z.strictObject({
        code: z.string().max(200000).optional().describe("Source code to review (use this or `files`)."),

        ...filesArg,

        language: z.string().max(100).optional(),

        focus: z
          .string()
          .max(1000)
          .optional()
          .describe("What to concentrate on, e.g. 'SQL injection' or 'N+1 queries'."),

        model: modelArg(config.deepModel),

        max_tokens: maxTokensArg(1536),
      }),

      annotations: READ_ONLY,

      handler: ollamaReviewCode,
    },

    {
      name: "ollama_explain_error",

      title: "Ollama: explain an error",

      description:
        "Ask the local LLM (default qwen2.5-coder 14B) to analyse an error message or log and list likely causes with checks and fixes." +
        filesHint,

      inputSchema: z.strictObject({
        error: z.string().min(1).max(100000).describe("Error message, stack trace or log excerpt."),

        context: z
          .string()
          .max(50000)
          .optional()
          .describe("Extra context: what was being done, environment, recent changes."),

        ...filesArg,

        model: modelArg(config.deepModel),

        max_tokens: maxTokensArg(1536),
      }),

      annotations: READ_ONLY,

      handler: ollamaExplainError,
    },

    {
      name: "ollama_list_models",

      title: "Ollama: list models",

      description: "List the models installed in the local Ollama with size, quantization and context length.",

      inputSchema: z.strictObject({}),

      annotations: { ...READ_ONLY, idempotentHint: true },

      handler: ollamaListModels,
    },

    {
      name: "ollama_health",

      title: "Ollama: health check",

      description:
        "Check that the local Ollama is reachable and show the server settings (default models, timeout, file access).",

      inputSchema: z.strictObject({}),

      annotations: { ...READ_ONLY, idempotentHint: true },

      handler: createHealthTool({ allowFiles }),
    },

    ...fileTools,
  ];
}
