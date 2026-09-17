// @effect-diagnostics nodeBuiltinImport:off - Exercise the standalone CLI against real disposable Git repositories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { KnowledgeCache, estimateTokens, git, serialize } from "./knowledge-cache.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-knowledge-test-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  const write = (path: string, value: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), value);
  };
  write("src/auth.ts", "export const retries = 3;\n");
  write("README.md", "Example\n");
  write(".gitignore", "ignored/\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  const cache = new KnowledgeCache(root);
  const answer = {
    question: "How does auth retry?",
    answer: "Auth allows three retries.",
    sources: ["src/auth.ts"],
    tags: ["authentication", "retries"],
  };
  const save = (scopes?: string[]) => cache.put(cache.prepare(scopes).ticket, answer).id;
  return { root, cache, answer, save, write };
}

describe("knowledge cache", () => {
  it("persists across sessions, retrieves by question/tags, and bounds output", () => {
    const { root, cache, save } = fixture();
    expect(cache.find("auth retry").results).toEqual([]);
    const id = save();
    expect(new KnowledgeCache(root).get(id).status).toBe("fresh");
    const response = cache.find("authentication retries");
    expect(response.results[0]).toMatchObject({ id, status: "fresh" });
    expect(response.estimatedTokens).toBe(estimateTokens(serialize(response)));
    expect(estimateTokens(serialize(cache.find("auth retry", 64)))).toBeLessThanOrEqual(64);
    expect(cache.find("unrelated terminal").results).toEqual([]);
  });

  it("invalidates same-size dirty edits even if mtime is restored, then revives on exact revert", () => {
    const { root, cache, save, write } = fixture();
    const id = save();
    const path = NodePath.join(root, "src/auth.ts");
    const stat = NodeFS.statSync(path);
    write("src/auth.ts", "export const retries = 4;\n");
    NodeFS.utimesSync(path, stat.atime, stat.mtime);
    expect(cache.get(id)).toMatchObject({ status: "stale" });
    expect(serialize(cache.find("auth retry"))).not.toContain("three retries");
    git(root, ["restore", "src/auth.ts"]);
    expect(cache.get(id).status).toBe("fresh");
  });

  it("catches untracked additions and excludes ignored build output", () => {
    const { cache, save, write } = fixture();
    const id = save();
    write("ignored/build.js", "irrelevant");
    expect(cache.get(id).status).toBe("fresh");
    write("src/new-handler.ts", "new behavior");
    expect(cache.get(id).status).toBe("stale");
  });

  it("invalidates deletions, staged changes and renames", () => {
    const { root, cache, save, write } = fixture();
    const id = save();
    NodeFS.unlinkSync(NodePath.join(root, "src/auth.ts"));
    expect(cache.get(id).status).toBe("stale");
    git(root, ["restore", "."]);
    git(root, ["mv", "src/auth.ts", "src/login.ts"]);
    expect(cache.get(id).status).toBe("stale");
    git(root, ["reset", "--hard", "HEAD"]);
    write("src/auth.ts", "changed");
    git(root, ["add", "."]);
    expect(cache.get(id).status).toBe("stale");
  });

  it("keeps narrow scopes fresh for unrelated changes but catches additions within them", () => {
    const { cache, save, write } = fixture();
    const id = save(["src"]);
    write("README.md", "unrelated");
    expect(cache.get(id).status).toBe("fresh");
    write("src/new.ts", "changed");
    expect(cache.get(id).status).toBe("stale");
  });

  it("refuses to publish when sources changed during research or citations are out of scope", () => {
    const { cache, answer, write } = fixture();
    const { ticket } = cache.prepare(["src"]);
    expect(() => cache.put(ticket, { ...answer, sources: ["README.md"] })).toThrow("within");
    write("src/auth.ts", "changed");
    expect(() => cache.put(ticket, answer)).toThrow("during research");
    expect(() => cache.put(cache.prepare().ticket, { ...answer, sources: ["../secret"] })).toThrow(
      "traversal",
    );
    expect(() => cache.prepare(["/etc"])).toThrow("relative");
    expect(() => cache.prepare(["missing"])).toThrow("no readable");
  });

  it("refreshes on demand and overwrites the same question atomically", () => {
    const { cache, answer, save, write } = fixture();
    const id = save();
    write("src/auth.ts", "export const retries = 4;");
    const { ticket } = cache.prepare();
    expect(cache.put(ticket, { ...answer, answer: "Four retries." }).id).toBe(id);
    expect(cache.get(id)).toMatchObject({ status: "fresh", answer: "Four retries." });
    expect(() => cache.put(ticket, answer)).toThrow();
  });

  it("follows content across branch switches without invalidating empty commits", () => {
    const { root, cache, save, write } = fixture();
    const id = save();
    git(root, ["commit", "--allow-empty", "-m", "no content change"]);
    expect(cache.get(id).status).toBe("fresh");
    git(root, ["switch", "-c", "other"]);
    write("src/auth.ts", "other behavior");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "other behavior"]);
    expect(cache.get(id).status).toBe("stale");
    git(root, ["switch", "main"]);
    expect(cache.get(id).status).toBe("fresh");
  });

  it("isolates linked worktrees", () => {
    const { root, cache, save } = fixture();
    const id = save();
    const other = `${root}-worktree`;
    roots.push(other);
    git(root, ["worktree", "add", "-b", "linked", other]);
    const linked = new KnowledgeCache(other);
    expect(linked.directory).not.toBe(cache.directory);
    expect(linked.get(id).status).toBe("miss");
  });

  it("withholds corrupt entries and fails closed on out-of-scope symlinks", () => {
    const { root, cache, save } = fixture();
    const id = save();
    const path = NodePath.join(cache.directory, "entries", `${id}.json`);
    NodeFS.writeFileSync(path, "{");
    expect(cache.get(id).status).toBe("invalid");
    expect(cache.find("auth retry").results).toEqual([]);
    save();
    NodeFS.unlinkSync(NodePath.join(root, "src/auth.ts"));
    const other = fixture();
    NodeFS.symlinkSync(NodePath.join(other.root, "README.md"), NodePath.join(root, "src/auth.ts"));
    expect(cache.get(id).status).toBe("invalid");
    expect(() => cache.prepare()).toThrow("Symlink target");
  });

  it("fingerprints empty submodules and rejects populated ones", () => {
    const { root, cache, save, write } = fixture();
    const commit = git(root, ["rev-parse", "HEAD"]).trim();
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},submodule`]);
    const id = save();
    NodeFS.mkdirSync(NodePath.join(root, "submodule"));
    expect(cache.get(id).status).toBe("fresh");
    git(root, ["commit", "--allow-empty", "-m", "new revision"]);
    const next = git(root, ["rev-parse", "HEAD"]).trim();
    git(root, ["update-index", "--cacheinfo", `160000,${next},submodule`]);
    expect(cache.get(id).status).toBe("stale");
    write("submodule/file.ts", "content");
    expect(cache.get(id).status).toBe("invalid");
    expect(() => cache.prepare()).toThrow("Populated submodule");
  });

  it("tracks in-scope symlink targets and rejects out-of-scope targets", () => {
    const { root, cache, save, write } = fixture();
    NodeFS.symlinkSync("src/auth.ts", NodePath.join(root, "auth-link.ts"));
    const id = save();
    expect(cache.get(id).status).toBe("fresh");
    expect(() => cache.prepare(["auth-link.ts"])).toThrow("in scope");
    write("src/auth.ts", "changed");
    expect(cache.get(id).status).toBe("stale");
  });

  it("fingerprints broken symlinks but never accepts them as citations", () => {
    const { root, cache, save, answer, write } = fixture();
    NodeFS.symlinkSync("missing.ts", NodePath.join(root, "broken.ts"));
    const id = save();
    expect(cache.get(id).status).toBe("fresh");
    expect(() => cache.put(cache.prepare().ticket, { ...answer, sources: ["broken.ts"] })).toThrow(
      "readable",
    );
    write("missing.ts", "new behavior");
    expect(cache.get(id).status).toBe("stale");
  });

  it("handles Unicode and whitespace filenames without shell interpretation", () => {
    const { cache, write } = fixture();
    const path = "src/a\n b-ñ.ts";
    write(path, "hello");
    const id = cache.put(cache.prepare().ticket, {
      question: "Unicode?",
      answer: "Supported",
      sources: [path],
    }).id;
    expect(cache.get(id).status).toBe("fresh");
    write(path, "bye");
    expect(cache.get(id).status).toBe("stale");
  });
});
