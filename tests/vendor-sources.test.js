// tests/vendor-sources.test.js — the vendored plugin modules match vendor/plur1bus-memory/SOURCES.json byte for byte.
// Local only: reads repository files, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "plur1bus-memory");
const sources = JSON.parse(readFileSync(join(ROOT, "SOURCES.json"), "utf8"));
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("vendored plugin sources", () => {
  it("SOURCES.json names the plugin repository and a full commit", () => {
    assert.match(sources.pluginRepo, /^https:\/\/github\.com\/Cyb3rb1ade\/openclaw-plur1bus-memory$/);
    assert.match(sources.pluginCommit, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(sources.files) && sources.files.length > 0);
  });

  it("every listed file exists and has the recorded sha256", () => {
    for (const { path, sha256: want } of sources.files) {
      assert.match(want, /^[0-9a-f]{64}$/, path);
      assert.equal(sha256(join(ROOT, path)), want, `${path} differs from SOURCES.json (re-copy it from the plugin commit, never edit it here)`);
    }
  });

  it("no vendored file is missing from SOURCES.json", () => {
    const listed = new Set(sources.files.map((f) => f.path));
    const present = walk(ROOT)
      .map((p) => relative(ROOT, p).split(sep).join("/"))
      .filter((p) => p !== "SOURCES.json");
    assert.deepEqual(present.sort(), [...listed].sort());
  });
});
