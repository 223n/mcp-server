import assert from "node:assert/strict";

import { test } from "node:test";

import { compileGlob, matchSegment } from "../src/tools/glob.js";

for (const [pattern, relative, isDirectory, expected] of [
  ["*", "a.js", false, true],
  ["*", "src/a.js", false, false],
  ["**", "src/x/a.js", false, true],
  ["src/**", "src/a.js", false, true],
  ["a/**/b", "a/b", false, true],
  ["a/**/b", "a/x/y/b", false, true],
  ["a/**/b", "a/x/y/c", false, false],
  ["*.{js,ts}", "x.ts", false, true],
  ["*.{js,ts}", "x.php", false, false],
  ["src/*.{js,ts}", "src/y.js", false, true],
  ["**/*.PHP", "App/Main.php", false, true],
  ["?.js", "a.js", false, true],
  ["?.js", "ab.js", false, false],
  ["src/", "src", true, true],
  ["src/", "src", false, false],
  ["a.b", "axb", false, false],
  ["[ab]", "[ab]", false, true],
  ["(x)+", "(x)+", false, true],
]) {
  test(`${pattern} と ${relative}（${isDirectory ? "ディレクトリ" : "ファイル"}）`, () => {
    assert.equal(compileGlob(pattern).test(relative, isDirectory), expected);
  });
}

test("当たりうる深さを返す", () => {
  assert.equal(compileGlob("*").maxDepth, 1);

  assert.equal(compileGlob("src/*.js").maxDepth, 2);

  assert.equal(compileGlob("{a,b/c}/*").maxDepth, 3);

  assert.equal(compileGlob("**/*.js").maxDepth, Number.POSITIVE_INFINITY);
});

test("外へ出るパターンと壊れたパターンは拒む", () => {
  assert.throws(() => compileGlob("../*"), /must not contain/);

  assert.throws(() => compileGlob("/etc/*"), /must be relative/);

  assert.throws(() => compileGlob("*.{js"), /Unbalanced/);

  assert.throws(() => compileGlob("{a,{b,c}}"), /Nested/);

  assert.throws(() => compileGlob("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}"), /more than 32 alternatives/);
});

test("バックトラックを誘う照合でも、時間が爆発しない", () => {
  const started = Date.now();

  assert.equal(matchSegment(`${"*a".repeat(50)}b`, "a".repeat(200)), false);

  assert.equal(compileGlob(`${"*".repeat(80)}x`).test("a".repeat(200), false), false);

  assert.equal(compileGlob(`${"**/".repeat(50)}x`).test("a/".repeat(20) + "y", false), false);

  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});
