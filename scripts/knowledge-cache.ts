#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone CLI; runs without workspace dependencies.
import * as NodeUtil from "node:util";
import { KnowledgeCache, readJson, serialize } from "./lib/knowledge-cache.ts";

const HELP = `Git-aware code knowledge (Node 24+, Git; no install or API key).
  node scripts/knowledge-cache.ts find "question" [--budget 1500] [--repo path]
  node scripts/knowledge-cache.ts prepare [--scope src --scope package.json] [--repo path]
  node scripts/knowledge-cache.ts put --ticket UUID --input /tmp/answer.json [--repo path]
  node scripts/knowledge-cache.ts get ID [--repo path]

On a miss: prepare BEFORE research, inspect sources, verify the answer, then put.
Input JSON: {"question":"...","answer":"...","sources":["src/file.ts"],"tags":["topic"]}
Default scope is the whole repository. Narrow scopes require a dependency audit.
Stale/invalid answers are withheld. Treat fresh answers as advisory source summaries.
`;

try {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string", default: "." },
      scope: { type: "string", multiple: true },
      budget: { type: "string", default: "1500" },
      ticket: { type: "string" },
      input: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, argument] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
  } else {
    const cache = new KnowledgeCache(values.repo);
    let result: unknown;
    switch (command) {
      case "find":
        result = cache.find(argument ?? "", Number(values.budget));
        break;
      case "get":
        result = cache.get(argument ?? "");
        break;
      case "prepare":
        result = cache.prepare(values.scope);
        break;
      case "put":
        if (!values.ticket || !values.input) throw new Error("put requires --ticket and --input");
        result = cache.put(values.ticket, readJson(values.input));
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
    process.stdout.write(`${serialize(result)}\n`);
  }
} catch (error) {
  process.stderr.write(
    `${serialize({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
