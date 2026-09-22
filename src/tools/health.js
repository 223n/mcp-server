import { config } from "../config/config.js";

import { ollamaRequest } from "../ollama/client.js";

import { fileRootsLabel, readRoots } from "./files.js";

import { cloneLabel, cloneReady, ownersLabel } from "./git.js";

import { githubReady } from "./github.js";

import { limiterStats } from "./ollama.js";

import { outputLabel, outputReady } from "./output.js";

export function createHealthTool({ allowFiles, allowWrites = false, local = false }) {
  return async function ollamaHealth(_args, ctx) {
    const signal = ctx?.mcpReq?.signal;

    const stats = limiterStats();

    const [version, tags] = await Promise.all([
      ollamaRequest("/api/version", undefined, { signal }),
      ollamaRequest("/api/tags", undefined, { signal }),
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
