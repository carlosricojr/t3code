#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Offline benchmark of the standalone CLI library.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  KnowledgeCache,
  estimateTokens,
  git,
  parseAnswer,
  readJson,
  serialize,
} from "./lib/knowledge-cache.ts";

const repo = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const corpus = readJson(NodePath.join(repo, "docs/experiments/knowledge-cache-corpus.json"));
if (!Array.isArray(corpus)) throw new Error("Expected an array of benchmark answers");
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-knowledge-eval-"));
try {
  const cases = corpus.map((input, index) => {
    const answer = parseAnswer(input);
    const expectedHashes: unknown = input.sourceSha256;
    const root = NodePath.join(temporary, String(index));
    NodeFS.mkdirSync(root, { recursive: true });
    git(root, ["init", "-b", "main"]);
    const sourceText = answer.sources
      .map((source) => {
        const content = NodeFS.readFileSync(NodePath.join(repo, source), "utf8");
        const actualHash = NodeCrypto.createHash("sha256").update(content).digest("hex");
        if (
          !expectedHashes ||
          typeof expectedHashes !== "object" ||
          (expectedHashes as Record<string, unknown>)[source] !== actualHash
        ) {
          throw new Error(
            `Eval source changed: ${source}. Review its curated answer before updating sourceSha256.`,
          );
        }
        const target = NodePath.join(root, source);
        NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
        NodeFS.writeFileSync(target, content);
        return `${source}\n${content}`;
      })
      .join("\n");
    const cache = new KnowledgeCache(root);
    const lookupCommand = `node scripts/knowledge-cache.ts find ${serialize(answer.question)}`;
    const cold = cache.find(answer.question);
    const prepared = cache.prepare();
    const stored = cache.put(prepared.ticket, answer);
    const start = performance.now();
    const warm = cache.find(answer.question);
    const warmLookupMs = performance.now() - start;
    if (warm.results[0]?.status !== "fresh") throw new Error("Warm lookup failed");
    const baseline = estimateTokens(answer.question) + estimateTokens(sourceText);
    const lookup = estimateTokens(lookupCommand) + estimateTokens(serialize(warm));
    // Explicitly account for miss, prepare, generated draft, put request and acknowledgements.
    const populationOverhead =
      estimateTokens(lookupCommand + serialize(cold)) +
      estimateTokens("node scripts/knowledge-cache.ts prepare" + serialize(prepared)) +
      2 * estimateTokens(serialize(answer)) +
      estimateTokens(
        `node scripts/knowledge-cache.ts put --ticket ${prepared.ticket} --input /tmp/answer.json` +
          serialize(stored),
      );
    const firstSource = answer.sources[0]!;
    NodeFS.appendFileSync(
      NodePath.join(root, firstSource),
      "\n// Benchmark-only comment: invalidate the fingerprint.\n",
    );
    const stale = cache.find(answer.question);
    if (stale.results[0]?.status !== "stale" || serialize(stale).includes(answer.answer))
      throw new Error("Stale answer leaked");
    const refresh = cache.prepare();
    cache.put(refresh.ticket, answer); // Comment-only edit leaves this curated answer valid.
    if (cache.get(stored.id).status !== "fresh") throw new Error("Refresh failed");
    return {
      question: answer.question,
      baselineTokensPerUse: baseline,
      warmTokensPerUse: lookup,
      populationOverheadTokens: populationOverhead,
      warmReductionPercent: Math.round(100 * (1 - lookup / baseline)),
      breakEvenUses:
        baseline > lookup ? 1 + Math.ceil(populationOverhead / (baseline - lookup)) : null,
      baselineTokensTenUses: baseline * 10,
      cacheTokensTenUses: baseline + populationOverhead + lookup * 9,
      warmLookupMs: Math.round(warmLookupMs * 10) / 10,
      staleWithheld: true,
      refreshSucceeded: true,
    };
  });
  const baseline = cases.reduce((sum, item) => sum + item.baselineTokensTenUses, 0);
  const cached = cases.reduce((sum, item) => sum + item.cacheTokensTenUses, 0);
  process.stdout.write(
    `${JSON.stringify(
      {
        methodology:
          "UTF-8 bytes / 4, rounded up. Whole cited files vs compact lookup + command. Includes initial population overhead; ten uses with nine warm hits. Offline curated answers, not model usage or answer-quality evaluation. Mutation/refresh checks are separate from the ten-use cost model.",
        cases,
        total: {
          baselineTokensTenUses: baseline,
          cacheTokensTenUses: cached,
          estimatedTokensSaved: baseline - cached,
          reductionPercent: Math.round(100 * (1 - cached / baseline)),
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
