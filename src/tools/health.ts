import type { ToolContext, ToolScope } from "../types.ts";

import { config } from "../config/config.ts";

import type { OllamaTags, OllamaVersion } from "../ollama/client.ts";

import { ollamaRequest } from "../ollama/client.ts";

import { fileRootsLabel, readRoots } from "./files.ts";

import { cloneLabel, cloneReady, ownersLabel } from "./git.ts";

import { githubReady } from "./github.ts";

import { limiterStats } from "./ollama.ts";

import { outputLabel, outputReady } from "./output.ts";

export function createHealthTool({ allowFiles, allowWrites = false, local = false }: ToolScope) {
  return async function ollamaHealth(_args: unknown, ctx?: ToolContext): Promise<string> {
    const signal = ctx?.mcpReq?.signal;

    const stats = limiterStats();

    const [version, tags] = await Promise.all([
      ollamaRequest<OllamaVersion>("/api/version", undefined, { signal }),
      ollamaRequest<OllamaTags>("/api/tags", undefined, { signal }),
    ]);

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
      `timeout: ${Math.round(config.ollamaTimeout / 1000)} s (idle), ${Math.round(config.ollamaMaxDuration / 1000)} s (total)`,
      `concurrency: ${stats.active} running, ${stats.queued} queued (max ${stats.max} + ${stats.maxQueue} queued)`,
      `file access: ${files}`,
      `output saving: ${output}`,
      `git clone: ${clone}`,
      `git writes: ${gitWrites}`,
      `github api: ${github}`,
    ].join("\n");
  };
}
