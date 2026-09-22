import { config } from "../config/config.js";

import { ollamaRequest } from "../ollama/client.js";

import { fileRootsLabel, readRoots } from "./files.js";

import { outputLabel, outputReady } from "./output.js";

export function createHealthTool({ allowFiles, allowWrites = false }) {
  return async function ollamaHealth(_args, ctx) {
    const signal = ctx?.mcpReq?.signal;

    const [version, tags] = await Promise.all([
      ollamaRequest("/api/version", undefined, { signal }),
      ollamaRequest("/api/tags", undefined, { signal }),
    ]);

    const files =
      allowFiles && readRoots().length > 0 ? `enabled (${fileRootsLabel()})` : "disabled";

    const output = allowWrites && outputReady() ? `enabled (${outputLabel()})` : "disabled";

    return [
      `Ollama OK (version ${version.version}) at ${config.ollamaUrl}`,
      `models installed: ${(tags.models ?? []).length}`,
      `default model: ${config.defaultModel}`,
      `deep model: ${config.deepModel}`,
      `timeout: ${Math.round(config.ollamaTimeout / 1000)} s`,
      `file access: ${files}`,
      `output saving: ${output}`,
    ].join("\n");
  };
}
