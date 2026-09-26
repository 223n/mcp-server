import type { ToolContext, ToolScope } from "../types.ts";

import type { UsageTotal } from "../audit.ts";

import { usageTotals } from "../audit.ts";

import { config } from "../config/config.ts";

import type { OllamaPs, OllamaTags, OllamaVersion } from "../ollama/client.ts";

import { ollamaRequest } from "../ollama/client.ts";

import { fileRootsLabel, readRoots } from "./files.ts";

import { cloneLabel, cloneReady, ownersLabel } from "./git.ts";

import { githubReady } from "./github.ts";

import { inputBudget, limiterStats } from "./ollama.ts";

import { outputLabel, outputReady } from "./output.ts";

// 読み込み中のモデルを「mock:latest (1.0 GB VRAM, context 8192, until ...)」の形にする。
// context_length は、実際に動いている長さを返す版の Ollama でだけ出る
function describeLoaded(ps: OllamaPs | undefined): string {
  if (!ps) {
    return "unknown (/api/ps is not available)";
  }

  const models = ps.models ?? [];

  if (models.length === 0) {
    return "none";
  }

  return models
    .map((m) => {
      const details = [
        m.size_vram !== undefined ? `${(m.size_vram / 1024 ** 3).toFixed(1)} GB VRAM` : "",
        m.context_length ? `context ${m.context_length}` : "",
        m.expires_at ? `until ${m.expires_at}` : "",
      ].filter(Boolean);

      return `${m.name}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
    })
    .join("; ");
}

// 「mock:latest: 2 calls, 20 prompt + 6 output tokens; ...」の形にする
function describeTotals(map: Map<string, UsageTotal>): string {
  return (
    [...map]
      .map(([key, t]) => `${key}: ${t.calls} calls, ${t.prompt_tokens} prompt + ${t.output_tokens} output tokens`)
      .join("; ") || "none"
  );
}

export function createHealthTool({ allowFiles, allowWrites = false, local = false }: ToolScope) {
  return async function ollamaHealth(_args: unknown, ctx?: ToolContext): Promise<string> {
    const signal = ctx?.mcpReq?.signal;

    const stats = limiterStats();

    // /api/ps は古い Ollama には無いため、失敗しても状態の確認全体は止めない
    const [version, tags, ps] = await Promise.all([
      ollamaRequest<OllamaVersion>("/api/version", undefined, { signal }),
      ollamaRequest<OllamaTags>("/api/tags", undefined, { signal }),
      ollamaRequest<OllamaPs>("/api/ps", undefined, { signal }).catch(() => undefined),
    ]);

    const context = config.ollamaNumCtx
      ? `num_ctx ${config.ollamaNumCtx} (OLLAMA_NUM_CTX); file input budget about ${inputBudget(undefined)} tokens`
      : `not sent (Ollama decides; see loaded models); file input budget about ${inputBudget(undefined)} tokens`;

    const files =
      allowFiles && readRoots().length > 0 ? `enabled (${fileRootsLabel()})` : "disabled";

    const output = allowWrites && outputReady() ? `enabled (${outputLabel()})` : "disabled";

    const clone = cloneReady()
      ? `enabled (${cloneLabel()}; owners: ${ownersLabel() || "none"})`
      : "disabled";

    const gitWrites = cloneReady() && local && config.gitAllowWrite ? "enabled" : "disabled";

    const github = githubReady()
      ? `enabled${local && config.githubAllowWrite ? " (writes allowed)" : " (read only)"}`
      : "disabled";

    return [
      `Ollama OK (version ${version.version}) at ${config.ollamaUrl}`,
      `models installed: ${(tags.models ?? []).length}`,
      `default model: ${config.defaultModel}`,
      `deep model: ${config.deepModel}`,
      `context: ${context}`,
      `loaded models: ${describeLoaded(ps)}`,
      `timeout: ${Math.round(config.ollamaTimeout / 1000)} s (idle), ${Math.round(config.ollamaMaxDuration / 1000)} s (total)`,
      `concurrency: ${stats.active} running, ${stats.queued} queued (max ${stats.max} + ${stats.maxQueue} queued)`,
      // このプロセスが動き始めてからの合計。stdio はクライアントごとに起動し直されるため、長い期間は監査ログのファイルで数える
      `delegated since this process started, by model: ${describeTotals(usageTotals().models)}`,
      `delegated since this process started, by identity: ${describeTotals(usageTotals().identities)}`,
      `file access: ${files}`,
      `output saving: ${output}`,
      `git clone: ${clone}`,
      `git writes: ${gitWrites}`,
      `github api: ${github}`,
    ].join("\n");
  };
}
