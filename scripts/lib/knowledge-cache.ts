// @effect-diagnostics nodeBuiltinImport:off - Standalone, dependency-free Node CLI library.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const VERSION = 1;
const MAX_JSON_BYTES = 1_000_000;
const hash = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
export const estimateTokens = (value: string) => Math.ceil(Buffer.byteLength(value, "utf8") / 4);
export const serialize = (value: unknown) => JSON.stringify(value);

export function git(root: string, args: string[]): string {
  return NodeChildProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_000)
    throw new Error("Expected nonempty text (max 32,000 characters)");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Expected an array (max 100 items)");
  return value.map(text);
}
function relativePath(value: string): string {
  if (value === ".") return value;
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`Use a repository-relative path without traversal: ${value}`);
  }
  return value;
}
const covers = (scopes: string[], path: string) =>
  scopes.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`));
const questionId = (question: string) =>
  hash(question.trim().toLowerCase().replace(/\s+/g, " ")).slice(0, 24);

export interface Answer {
  question: string;
  answer: string;
  sources: string[];
  tags: string[];
}
interface Receipt {
  version: number;
  scopes: string[];
  digest: string;
}
interface Entry extends Answer, Receipt {
  id: string;
}
export function parseAnswer(value: unknown): Answer {
  const object = record(value);
  const sources = strings(object.sources).map(relativePath);
  if (!sources.length || sources.includes(".")) throw new Error("Cite at least one source file");
  return {
    question: text(object.question),
    answer: text(object.answer),
    sources,
    tags: strings(object.tags ?? []),
  };
}
function parseReceipt(value: unknown): Receipt {
  const object = record(value);
  const scopes = strings(object.scopes).map(relativePath);
  if (
    object.version !== VERSION ||
    !scopes.length ||
    typeof object.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(object.digest)
  )
    throw new Error("Invalid cache version or fingerprint");
  return { version: VERSION, scopes, digest: object.digest };
}
export function readJson(path: string): unknown {
  if (NodeFS.statSync(path).size > MAX_JSON_BYTES) throw new Error("JSON exceeds 1 MB");
  return JSON.parse(NodeFS.readFileSync(path, "utf8"));
}
function atomicJson(path: string, value: unknown): void {
  const content = serialize(value);
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_BYTES) throw new Error("JSON exceeds 1 MB");
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    NodeFS.renameSync(temporary, path);
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

export type Lookup =
  | {
      id: string;
      question?: string;
      status: "miss" | "stale" | "invalid" | "over-budget";
      scopes?: string[];
    }
  | {
      id: string;
      question: string;
      status: "fresh";
      answer: string;
      sources: string[];
      scopes: string[];
    };

/** Local advisory knowledge; freshness covers declared files, not semantic truth. */
export class KnowledgeCache {
  readonly root: string;
  readonly directory: string;
  constructor(root: string) {
    this.root = git(root, ["rev-parse", "--show-toplevel"]).trim();
    this.directory = NodePath.resolve(
      this.root,
      git(this.root, ["rev-parse", "--git-path", "t3-knowledge-v1"]).trim(),
    );
  }

  private snapshot(scopes: string[]): { digest: string; files: Set<string> } {
    // Stage records detect conflicts and gitlinks, even in an unpopulated submodule.
    const tracked = git(this.root, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
    const paths = new Set(
      git(this.root, ["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    );
    const gitlinks = new Map<string, string>();
    for (const entry of tracked) {
      const tab = entry.indexOf("\t");
      const path = entry.slice(tab + 1);
      if (!covers(scopes, path)) continue;
      const [mode, object, stage] = entry.slice(0, tab).split(" ");
      if (stage !== "0") throw new Error("Conflicted files cannot be cached");
      if (mode === "160000") gitlinks.set(path, object!);
      paths.add(path);
    }
    const digest = NodeCrypto.createHash("sha256");
    const files = new Set<string>();
    const checkedDirectories = new Set<string>();
    for (const path of [...paths].filter((path) => covers(scopes, path)).sort()) {
      relativePath(path);
      const absolute = NodePath.join(this.root, path);
      try {
        // Never follow a replaced parent directory outside this worktree.
        let parent = NodePath.dirname(absolute);
        while (parent !== this.root && !checkedDirectories.has(parent)) {
          if (NodeFS.lstatSync(parent).isSymbolicLink())
            throw new Error(`Symlink dependency: ${path}`);
          checkedDirectories.add(parent);
          parent = NodePath.dirname(parent);
        }
        const stat = NodeFS.lstatSync(absolute);
        if (gitlinks.has(path)) {
          if (!stat.isDirectory() || NodeFS.readdirSync(absolute).length) {
            throw new Error(`Populated submodule cannot be cached: ${path}`);
          }
          digest.update(serialize([path, "gitlink", gitlinks.get(path)]));
          continue;
        }
        if (stat.isSymbolicLink()) {
          const link = NodeFS.readlinkSync(absolute);
          let target: string;
          try {
            target = NodePath.relative(this.root, NodeFS.realpathSync(absolute))
              .split(NodePath.sep)
              .join("/");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              digest.update(serialize([path, "symlink", link, "missing"]));
              continue;
            }
            throw new Error(`Unresolvable symlink dependency: ${path}`, { cause: error });
          }
          if (
            !paths.has(target) ||
            !covers(scopes, target) ||
            !NodeFS.statSync(NodePath.join(this.root, target)).isFile()
          ) {
            throw new Error(`Symlink target must be a Git-visible file in scope: ${path}`);
          }
          digest.update(serialize([path, "symlink", link, target]));
          files.add(path);
          continue;
        }
        if (!stat.isFile()) throw new Error(`Non-regular dependency: ${path}`);
        digest.update(serialize([path, stat.mode & 0o111, hash(NodeFS.readFileSync(absolute))]));
        files.add(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        digest.update(
          serialize(gitlinks.has(path) ? [path, "gitlink", gitlinks.get(path)] : [path, "missing"]),
        );
      }
    }
    return { digest: digest.digest("hex"), files };
  }

  prepare(scopes: string[] = ["."]): { ticket: string; scopes: string[]; fileCount: number } {
    scopes = [...new Set(scopes.map(relativePath))].sort();
    if (!scopes.length || scopes.length > 100) throw new Error("Choose 1–100 dependency scopes");
    const snapshot = this.snapshot(scopes);
    if (!snapshot.files.size) throw new Error("Scopes contain no readable Git-visible files");
    const ticket = NodeCrypto.randomUUID();
    atomicJson(NodePath.join(this.directory, "receipts", `${ticket}.json`), {
      version: VERSION,
      scopes,
      digest: snapshot.digest,
    });
    return { ticket, scopes, fileCount: snapshot.files.size };
  }

  put(ticket: string, input: unknown): { id: string; status: "stored" } {
    if (!/^[a-f0-9-]{36}$/.test(ticket)) throw new Error("Invalid ticket");
    const receiptPath = NodePath.join(this.directory, "receipts", `${ticket}.json`);
    const receipt = parseReceipt(readJson(receiptPath));
    const answer = parseAnswer(input);
    const snapshot = this.snapshot(receipt.scopes);
    if (snapshot.digest !== receipt.digest)
      throw new Error("Sources changed during research; prepare again and reverify the answer");
    if (answer.sources.some((path) => !snapshot.files.has(path)))
      throw new Error("Every citation must be a readable file within the prepared scopes");
    const id = questionId(answer.question);
    atomicJson(NodePath.join(this.directory, "entries", `${id}.json`), {
      ...receipt,
      ...answer,
      id,
    });
    NodeFS.rmSync(receiptPath, { force: true });
    return { id, status: "stored" };
  }

  private entry(id: string): Entry {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid entry id");
    const value = readJson(NodePath.join(this.directory, "entries", `${id}.json`));
    const answer = parseAnswer(value);
    const receipt = parseReceipt(value);
    if (
      questionId(answer.question) !== id ||
      record(value).id !== id ||
      answer.sources.some((path) => !covers(receipt.scopes, path))
    )
      throw new Error("Invalid entry identity or citations");
    return { ...answer, ...receipt, id };
  }

  private validate(
    entry: Entry,
    snapshots = new Map<string, ReturnType<KnowledgeCache["snapshot"]>>(),
  ): Lookup {
    try {
      const key = serialize(entry.scopes);
      const snapshot = snapshots.get(key) ?? this.snapshot(entry.scopes);
      snapshots.set(key, snapshot);
      if (
        snapshot.digest !== entry.digest ||
        entry.sources.some((path) => !snapshot.files.has(path))
      ) {
        return { id: entry.id, question: entry.question, status: "stale", scopes: entry.scopes };
      }
      return {
        id: entry.id,
        question: entry.question,
        status: "fresh",
        answer: entry.answer,
        sources: entry.sources,
        scopes: entry.scopes,
      };
    } catch {
      return { id: entry.id, question: entry.question, status: "invalid" };
    }
  }

  get(id: string): Lookup {
    try {
      return this.validate(this.entry(id));
    } catch (error) {
      return {
        id,
        status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "miss" : "invalid",
      };
    }
  }

  find(query: string, budget = 1500): { results: Lookup[]; estimatedTokens: number } {
    if (!Number.isSafeInteger(budget) || budget < 64 || budget > 32_000)
      throw new Error("Budget must be 64–32,000 estimated tokens");
    const terms = [
      ...new Set(
        text(query)
          .toLowerCase()
          .match(/[\p{L}\p{N}_]+/gu) ?? [],
      ),
    ];
    if (!terms.length) throw new Error("Query must contain words");
    const directory = NodePath.join(this.directory, "entries");
    const names = NodeFS.existsSync(directory) ? NodeFS.readdirSync(directory) : [];
    const candidates: { entry: Entry; score: number }[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      try {
        const entry = this.entry(name.slice(0, -5));
        const words = new Set(
          `${entry.question} ${entry.tags.join(" ")}`.toLowerCase().match(/[\p{L}\p{N}_]+/gu),
        );
        const score = terms.filter((term) => words.has(term)).length / terms.length;
        if (score >= 0.5) candidates.push({ entry, score });
      } catch {
        /* Corrupt entries are misses, never reusable answers. */
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    const results: Lookup[] = [];
    const snapshots = new Map<string, ReturnType<KnowledgeCache["snapshot"]>>();
    // Reserve envelope overhead; budget accounts for the actual compact CLI output.
    for (const { entry } of candidates.slice(0, 3)) {
      let result = this.validate(entry, snapshots);
      if (
        estimateTokens(serialize({ results: [...results, result], estimatedTokens: 99999 })) >
        budget
      ) {
        result = { id: entry.id, status: "over-budget" };
      }
      if (
        estimateTokens(serialize({ results: [...results, result], estimatedTokens: 99999 })) <=
        budget
      )
        results.push(result);
    }
    const response = { results, estimatedTokens: 0 };
    // Iterate until the digit count of the estimate stabilizes.
    for (let index = 0; index < 4; index++)
      response.estimatedTokens = estimateTokens(serialize(response));
    return response;
  }
}
