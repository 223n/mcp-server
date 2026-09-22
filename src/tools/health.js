import { config } from "../config/config.js";

import { ollamaRequest } from "../ollama/client.js";

import { fileRootsLabel } from "./files.js";

export function createHealthTool({ allowFiles }) {
  return async function ollamaHealth(_args, ctx) {
    const signal = ctx?.mcpReq?.signal;

    const [version, tags] = await Promise.all([
      ollamaRequest("/api/version", undefined, { signal }),
      ollamaRequest("/api/tags", undefined, { signal }),
    ]);

    const files =
      allowFiles && config.fileRoots.length > 0
        ? `enabled (${fileRootsLabel()})`
        : "disabled";

    return [
      `Ollama OK (version ${version.version}) at ${config.ollamaUrl}`,
      `models installed: ${(tags.models ?? []).length}`,
      `default model: ${config.defaultModel}`,
      `deep model: ${config.deepModel}`,
      `timeout: ${Math.round(config.ollamaTimeout / 1000)} s`,
      `file access: ${files}`,
    ].join("\n");
  };
}
