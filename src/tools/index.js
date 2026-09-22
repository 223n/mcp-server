import * as z from "zod";

import { config } from "../config/config.js";

import { SYSTEM_PROMPTS } from "../config/prompts.js";

import { ollamaExplainError } from "./error.js";

import { fileRootsLabel, listFiles, readOneFile, readRoots } from "./files.js";

import { cloneLabel, cloneReady, gitClone, gitRead, gitWrite, ownersLabel } from "./git.js";

import { githubRead, githubReady, githubWrite } from "./github.js";

import { createHealthTool } from "./health.js";

import { ollamaChatTool, ollamaListModels } from "./ollama.js";

import { outputLabel, outputReady } from "./output.js";

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

// git と GitHub のツール。書き込み系は local（stdio）でだけ登録する
function buildGitTools({ local }) {
  const tools = [];

  if (cloneReady()) {
    tools.push(
      {
        name: "git_clone",

        title: "Git: clone a repository",

        description:
          `Clone a GitHub repository into ${cloneLabel()} on the machine that runs Ollama, so its files can be passed to the Ollama tools. ` +
          `Only these owners are allowed: ${ownersLabel() || "(none configured)"}. ` +
          "Pass `owner/repo`, never a URL. A shallow, single-branch clone without submodules.",

        inputSchema: z.strictObject({
          repo: z.string().max(140).describe('The repository as "owner/repo", for example "223n/mcp-server".'),

          ref: z.string().max(200).optional().describe("Branch or tag to check out. Default: the repository's default branch."),

          depth: z.number().int().positive().max(200).optional().describe("How much history to fetch. Default 1."),
        }),

        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

        handler: gitClone,
      },

      {
        name: "git_read",

        title: "Git: read a cloned repository",

        description:
          "Read the state of a cloned repository: status, log, diff, show, branches or remotes. " +
          "Secret files are excluded from diffs, and file contents are not returned by `show`. Read-only.",

        inputSchema: z.strictObject({
          repo: z.string().max(140).describe('The cloned repository as "owner/repo".'),

          op: z
            .enum(["status", "log", "diff", "show", "branches", "remotes"])
            .describe("What to read."),

          ref: z.string().max(200).optional().describe("Branch, tag or commit, for `log`, `diff` and `show`."),

          limit: z.number().int().positive().max(200).optional().describe("Maximum entries for `log`. Default 20."),

          staged: z.boolean().optional().describe("For `diff`, compare the staged changes instead of the working tree."),

          stat_only: z.boolean().optional().describe("For `diff`, return the summary instead of the full patch."),
        }),

        annotations: { ...READ_ONLY, idempotentHint: true },

        handler: gitRead,
      },
    );
  }

  if (cloneReady() && local && config.gitAllowWrite) {
    tools.push({
      name: "git_write",

      title: "Git: change a cloned repository",

      description:
        "Fetch, switch or create a branch, stage files, commit and push in a cloned repository. " +
        "Pushing to main, master or develop is always refused. Available over stdio only.",

      inputSchema: z.strictObject({
        repo: z.string().max(140).describe('The cloned repository as "owner/repo".'),

        op: z
          .enum(["fetch", "switch", "create_branch", "add", "commit", "push"])
          .describe("What to do."),

        branch: z.string().max(200).optional().describe("Branch name for `switch`, `create_branch` and `push`."),

        paths: z.array(z.string().max(1024)).max(50).optional().describe("Paths to stage, relative to the repository root."),

        message: z.string().max(4000).optional().describe("Commit message."),
      }),

      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

      handler: gitWrite,
    });
  }

  if (githubReady()) {
    tools.push({
      name: "github_read",

      title: "GitHub: read pull requests and issues",

      description:
        `Read pull requests, issues, diffs, comments and check runs from GitHub for these owners: ${ownersLabel() || "(none configured)"}. ` +
        "Uses the REST API directly, so the gh CLI is not needed. Read-only.",

      inputSchema: z.strictObject({
        repo: z.string().max(140).describe('The repository as "owner/repo".'),

        op: z
          .enum(["pr_list", "pr_view", "pr_diff", "pr_comments", "pr_checks", "issue_list", "issue_view"])
          .describe("What to read."),

        number: z.number().int().positive().optional().describe("Pull request or issue number, for the single-item operations."),

        state: z.enum(["open", "closed", "all"]).optional().describe("Filter for the list operations. Default open."),

        limit: z.number().int().positive().max(100).optional().describe("Maximum items. Default 20."),
      }),

      annotations: { ...READ_ONLY, idempotentHint: true, openWorldHint: true },

      handler: githubRead,
    });
  }

  if (githubReady() && local && config.githubAllowWrite) {
    tools.push({
      name: "github_write",

      title: "GitHub: open a pull request or comment",

      description:
        "Open a pull request, or comment on a pull request or issue. " +
        "A pull request whose head is main, master or develop is refused, because merging it would delete that branch. Available over stdio only.",

      inputSchema: z.strictObject({
        repo: z.string().max(140).describe('The repository as "owner/repo".'),

        op: z.enum(["pr_create", "comment"]).describe("What to do."),

        title: z.string().max(400).optional().describe("Pull request title."),

        head: z.string().max(200).optional().describe("Branch the changes are on."),

        base: z.string().max(200).optional().describe("Branch to merge into."),

        number: z.number().int().positive().optional().describe("Pull request or issue number, for `comment`."),

        body: z.string().max(60000).optional().describe("Pull request description, or comment text."),
      }),

      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

      handler: githubWrite,
    });
  }

  return tools;
}

export function buildTools({ allowFiles, allowWrites = false, local = false }) {
  const filesEnabled = allowFiles && readRoots().length > 0;

  const writesEnabled = allowWrites && outputReady();

  const filesArg = filesEnabled
    ? {
        files: z
          .array(z.string().max(1024))
          .max(20)
          .optional()
          .describe(
            `Absolute paths or globs under: ${fileRootsLabel()} (Windows or container paths). The server reads them, so do not paste file contents yourself. Append \`#L10-200\` for a line range. A glob such as \`C:\\dev\\app\\src\\**\\*.php\` expands to at most 40 files. Pass a glob, not a bare directory.`,
          ),
      }
    : {};

  // ファイル機能の有無に関わらず常に出す。サーバーはファイルシステムに触れないため
  const inlineFilesArg = {
    inline_files: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(200).describe("Display name; its extension picks the fence language."),

          content: z.string().max(90000),
        }),
      )
      .max(10)
      .optional()
      .describe(
        `Files whose text you already have and the server cannot read (outside the allowed roots, or from this session). This does NOT save tokens: you pay for \`content\` either way.${filesEnabled ? " When a path is readable by the server, use `files` instead." : ""}`,
      ),

    line_numbers: z
      .boolean()
      .optional()
      .describe("Prefix file lines with line numbers (default false)."),
  };

  const saveArgs = writesEnabled
    ? {
        save_output: z
          .boolean()
          .optional()
          .describe(
            `Write the answer to a file under ${outputLabel()} instead of returning it in full. The response then carries the path, the first and last part of the text, and the usual stats. Use it for long drafts and translations.`,
          ),

        output_name: z
          .string()
          .max(64)
          .optional()
          .describe(
            'Base name for the saved file, letters, digits, "_" and "-" only (no dots, no path separators). The server adds ".md" and never overwrites.',
          ),
      }
    : {};

  const filesHint = filesEnabled
    ? ` Prefer passing \`files\` (paths under ${fileRootsLabel()}) over pasting contents: it saves Claude tokens.`
    : "";

  const saveHint = writesEnabled
    ? ` Long answers can be written to a file with \`save_output\` instead of being returned in full.`
    : "";

  // 保存を有効にしたときは、読み取り専用だと名乗らない
  const CHAT_ANNOTATIONS = writesEnabled ? { ...READ_ONLY, readOnlyHint: false } : READ_ONLY;

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

        {
          name: "read_file",

          title: "Files: read one file",

          description:
            `Read one file under ${fileRootsLabel()} on the machine that runs Ollama, without sending it to the local model. ` +
            "Use it to read back what `save_output` wrote, or to check a small file. Append `#L10-200` to read only part of it. Read-only.",

          inputSchema: z.strictObject({
            path: z
              .string()
              .max(1024)
              .describe("Absolute path of the file, optionally with a `#L10-200` line range."),

            line_numbers: z
              .boolean()
              .optional()
              .describe("Prefix lines with line numbers (default false)."),
          }),

          annotations: { ...READ_ONLY, idempotentHint: true },

          handler: (args) => readOneFile(args.path, { lineNumbers: args.line_numbers ?? false }),
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
        filesHint +
        saveHint,

      inputSchema: z.strictObject({
        prompt: z.string().min(1).max(200000).describe("The full instruction for the local model."),

        model: modelArg(config.defaultModel),

        profile: z
          .enum(Object.keys(SYSTEM_PROMPTS))
          .optional()
          .describe("Preset system prompt (ignored when `system` is given)."),

        system: z.string().max(20000).optional().describe("Custom system prompt."),

        ...filesArg,

        ...inlineFilesArg,

        ...saveArgs,

        temperature: z.number().min(0).max(2).optional().describe("Default 0.7."),

        max_tokens: maxTokensArg(4096),
      }),

      annotations: CHAT_ANNOTATIONS,

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
        code: z.string().max(200000).optional().describe("Source code to review (use this, `files` or `inline_files`)."),

        ...filesArg,

        ...inlineFilesArg,

        ...saveArgs,

        language: z.string().max(100).optional(),

        focus: z
          .string()
          .max(1000)
          .optional()
          .describe("What to concentrate on, e.g. 'SQL injection' or 'N+1 queries'."),

        model: modelArg(config.deepModel),

        max_tokens: maxTokensArg(1536),
      }),

      annotations: CHAT_ANNOTATIONS,

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

        ...inlineFilesArg,

        ...saveArgs,

        model: modelArg(config.deepModel),

        max_tokens: maxTokensArg(1536),
      }),

      annotations: CHAT_ANNOTATIONS,

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

      handler: createHealthTool({ allowFiles, allowWrites, local }),
    },

    ...fileTools,

    ...buildGitTools({ local }),
  ];
}
