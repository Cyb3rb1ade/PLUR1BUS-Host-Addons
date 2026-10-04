// tests/dist-ci-helpers.test.js — the helpers of .github/workflows/plugin-dist.yml (HM1 Task 8)
// and a static check of the workflow itself. Local only: temp dirs, the repo's own
// @lancedb/lancedb and engine, ephemeral TEST ONLY keys; never a real OpenClaw.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { parse as parseYaml } from "yaml";

import { assertDisposable } from "./helpers/assert-disposable.mjs";
import { digestIds, storeDigest } from "./helpers/store-digest.mjs";
import { assertStoreInsideStateDir, seedStore } from "./helpers/seed-store.mjs";
import { rewriteHermesProviderUrlsForWsl, rewriteHermesSidecarFromArtefacts, signFeedForCi, windowsFileUrlAsWsl } from "./helpers/sign-feed-for-ci.mjs";
import { bootstrapEnv, isUpToDate, lastJson } from "./helpers/ci-hermes-dist.mjs";
import { comparePins, parseShasums } from "./helpers/check-node-pins.mjs";
import { validateFeed } from "../scripts/dist/build-plugin-feed.mjs";
import { verifyMinisign } from "../scripts/dist/minisign.mjs";
import { pluginCheckout } from "./helpers/plugin-checkout.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createInstallerSandbox } from "./helpers/installer-sandbox.js";
import { buildInstaller } from "../scripts/dist/build-installer.mjs";
import { DEFAULT_NODE_PINS, renderBootstraps } from "../scripts/dist/render-bootstraps.mjs";

/** The bootstrap's node_ok gate: package.json engines ">=24.16.0 <25 || >=26.1.0". */
function nodeMeetsEngines() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  return (maj === 24 && min >= 16) || maj > 26 || (maj === 26 && min >= 1);
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// The plugin is not in this repository: its real MemoryDB comes from a checkout (see helpers/plugin-checkout.js).
const PLUGIN = pluginCheckout();
const HELPERS = join(REPO, "tests", "helpers");
const WORKFLOW = join(REPO, ".github", "workflows", "plugin-dist.yml");

/** npm pack of a minimal package carrying the fields the feed builder reads; returns the file name. */
function packTiny(dir, v) {
  const d = join(dir, `pkg-${v}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@cyb3rb1ade/plur1bus-memory", version: v, type: "module", main: "./index.js", license: "MIT", openclaw: { extensions: ["./index.js"], compat: { pluginApi: ">=2026.8.1", minGatewayVersion: "2026.8.1" } }, engines: { node: ">=24.16.0 <25 || >=26.1.0" } }));
  writeFileSync(join(d, "index.js"), "export default {};\n");
  const npmCli = [join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")].find((p) => existsSync(p));
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", dir], { cwd: d, encoding: "utf8" })
    : spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], { cwd: d, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout)[0].filename;
}

/** A pack artefact like plugin-dist's `pack` job makes: two tarballs, pack.json, installer bundle, TEST ONLY bootstraps. */
async function packArtefact(dir, { version = "7.16.11", real = false } = {}) {
  const ciVersion = `${version}-ci.0`;
  const ciTgz = packTiny(dir, ciVersion);
  const tgz = packTiny(dir, version);
  if (real) {
    await buildInstaller({ out: join(dir, "plur1bus-plugin-installer.mjs") });
    const { sh, ps1 } = renderBootstraps({ testKey: true, nodePins: DEFAULT_NODE_PINS });
    writeFileSync(join(dir, "install-plugin.sh"), sh, { mode: 0o755 });
    writeFileSync(join(dir, "install-plugin.ps1"), ps1);
  } else {
    writeFileSync(join(dir, "plur1bus-plugin-installer.mjs"), "// TEST ONLY installer\n");
    writeFileSync(join(dir, "install-plugin.sh"), "#!/bin/sh\n# TEST ONLY\n");
    writeFileSync(join(dir, "install-plugin.ps1"), "# TEST ONLY\n");
  }
  const integrity = (f) => `sha512-${createHash("sha512").update(readFileSync(join(dir, f))).digest("base64")}`;
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ version, ciVersion, tgz, ciTgz }));
  return { version, ciVersion, tgz, ciTgz, integrity: { [version]: integrity(tgz), [ciVersion]: integrity(ciTgz) } };
}

describe("plugin-dist CI helpers", () => {
  it("assert-disposable refuses a state dir outside RUNNER_TEMP or os.tmpdir()", () => {
    const runnerTemp = makeTempDir("runner-temp-");
    const inside = { RUNNER_TEMP: runnerTemp, OPENCLAW_HOME: join(runnerTemp, "oc-home"), OPENCLAW_STATE_DIR: join(runnerTemp, "oc-state") };
    assert.equal(assertDisposable({ env: inside }).ok, true);

    const outside = { ...inside, OPENCLAW_STATE_DIR: join(REPO, "not-temp", ".openclaw") };
    const r = assertDisposable({ env: outside });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /OPENCLAW_STATE_DIR/);

    // without RUNNER_TEMP the root is os.tmpdir(); an unset variable is refused too
    assert.equal(assertDisposable({ env: { OPENCLAW_HOME: join(tmpdir(), "a"), OPENCLAW_STATE_DIR: join(tmpdir(), "b") } }).ok, true);
    assert.equal(assertDisposable({ env: { OPENCLAW_HOME: join(tmpdir(), "a") } }).ok, false);
    // a sibling that merely shares the prefix is outside
    assert.equal(assertDisposable({ env: { ...inside, OPENCLAW_HOME: `${runnerTemp}-evil` } }).ok, false);
    // the temp root itself is not a disposable instance
    assert.equal(assertDisposable({ env: { ...inside, OPENCLAW_STATE_DIR: runnerTemp } }).ok, false);
    // extra variables (HOME for the POSIX legs)
    assert.equal(assertDisposable({ env: { ...inside, HOME: "/home/someone" }, vars: ["HOME"] }).ok, false);

    const cli = spawnSync(process.execPath, [join(HELPERS, "assert-disposable.mjs")], { env: { ...process.env, ...outside }, encoding: "utf8" });
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stderr, /not disposable/);
    const ok = spawnSync(process.execPath, [join(HELPERS, "assert-disposable.mjs")], { env: { ...process.env, ...inside }, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
  });

  it("store-digest is stable across row order", async () => {
    assert.deepEqual(digestIds(["main/b", "main/a", "ops/c"]), digestIds(["ops/c", "main/a", "main/b"]));
    assert.notEqual(digestIds(["main/a"]).sha256, digestIds(["main/a", "main/b"]).sha256);

    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `m-${i}`, text: `TEST ONLY ${i}`, vector: [i, 1] }));
    const a = makeTempDir("digest-a-");
    const b = makeTempDir("digest-b-");
    const ta = await (await lancedb.connect(join(a, "main"))).createTable("memories", rows);
    const tb = await (await lancedb.connect(join(b, "main"))).createTable("memories", [...rows].reverse().slice(0, 3));
    await tb.add([...rows].reverse().slice(3));
    ta.close();
    tb.close();
    const da = await storeDigest({ baseDbPath: a });
    const db = await storeDigest({ baseDbPath: b });
    assert.equal(da.rows, 7);
    assert.equal(da.sha256, db.sha256);
    assert.deepEqual(da.tables, ["main"]);

    const cli = spawnSync(process.execPath, [join(HELPERS, "store-digest.mjs"), "--base-db-path", a], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).sha256, da.sha256);
  });

  it("seed-store refuses a baseDbPath outside the given state dir", async () => {
    const stateDir = makeTempDir("seed-state-");
    const outside = join(makeTempDir("seed-outside-"), "store");
    assert.throws(() => assertStoreInsideStateDir(stateDir, outside), /outside the state dir/);
    assert.throws(() => assertStoreInsideStateDir(stateDir, stateDir), /outside the state dir/);
    assert.throws(() => assertStoreInsideStateDir(stateDir, `${stateDir}-x/store`), /outside the state dir/);
    assert.doesNotThrow(() => assertStoreInsideStateDir(stateDir, join(stateDir, "memory", "lancedb-namespaced")));
    await assert.rejects(seedStore({ stateDir, baseDbPath: outside, pluginDir: REPO, count: 1 }), /outside the state dir/);
    assert.equal(existsSync(outside), false, "nothing written outside");

    const cli = spawnSync(process.execPath, [join(HELPERS, "seed-store.mjs"), "--state-dir", stateDir, "--base-db-path", outside, "--plugin-dir", REPO], { encoding: "utf8" });
    assert.equal(cli.status, 2, cli.stderr);
    assert.equal(existsSync(outside), false);
  });

  it("seed-store writes synthetic memories through the plugin's own MemoryDB and store-digest counts them", { skip: PLUGIN.skip }, async () => {
    const stateDir = makeTempDir("seed-real-");
    const baseDbPath = join(stateDir, "memory", "lancedb-namespaced");
    const seeded = await seedStore({ stateDir, baseDbPath, pluginDir: PLUGIN.dir, count: 12 });
    assert.equal(seeded.rows, 12);
    const d = await storeDigest({ baseDbPath, pluginDir: PLUGIN.dir });
    assert.equal(d.rows, 12);
    assert.equal(d.sha256, digestIds(Array.from({ length: 12 }, (_, i) => `ci-seed/ci-seed-${String(i).padStart(3, "0")}`)).sha256);
    await assert.rejects(seedStore({ stateDir, baseDbPath, pluginDir: PLUGIN.dir, count: 1 }), /already has/);
  });

  it("sign-feed-for-ci builds and signs a file:// feed with both releases, newest first", async () => {
    const dir = makeTempDir("sign-feed-");
    const { tgz: name, ciTgz: ciName } = await packArtefact(dir);
    const out = join(dir, "feed");
    const r = await signFeedForCi({ artefacts: dir, outDir: out });
    const feedBytes = readFileSync(join(out, "stable.json"));
    const feed = JSON.parse(feedBytes.toString("utf8"));
    assert.deepEqual(feed.hosts.openclaw.releases.map((x) => x.version), ["7.16.11", "7.16.11-ci.0"]);
    assert.equal(feed.hosts.openclaw.latest, "7.16.11");
    assert.equal(feed.installer.url, pathToFileURL(join(dir, "plur1bus-plugin-installer.mjs")).href);
    assert.equal(feed.hosts.openclaw.releases[1].tarball.url, pathToFileURL(join(dir, ciName)).href);
    assert.equal(validateFeed(feed).ok, false, "file:// URLs are refused without allowFile");
    assert.equal(validateFeed(feed, { allowFile: true }).ok, true);
    const sig = readFileSync(join(out, "stable.json.minisig"), "utf8");
    assert.match(sig, /TEST ONLY/);
    assert.equal(verifyMinisign({ message: feedBytes, signatureText: sig, publicKey: r.publicKey }).ok, true);
    assert.equal(r.feedUrl, pathToFileURL(join(out, "stable.json")).href);
    assert.equal(readFileSync(join(out, "pubkey.txt"), "utf8").trim(), r.publicKey);

    const genv = join(dir, "github-env");
    const cli = spawnSync(process.execPath, [join(HELPERS, "sign-feed-for-ci.mjs"), "--artefacts", dir, "--out-dir", join(dir, "feed2"), "--github-env", genv], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const lines = readFileSync(genv, "utf8");
    assert.match(lines, /^PLUR1BUS_PLUGIN_PUBKEY=RW[A-Za-z0-9+/=]+$/m);
    assert.match(lines, /^PLUR1BUS_PLUGIN_FEED=file:\/\/.+stable\.json$/m);
  });
  it("local dry run: the installer leg (install-plugin.sh, signed file:// feed, bundle) against the sandbox shims", { skip: (process.platform === "win32" && "POSIX sh bootstrap and a symlinked plugin dir") || PLUGIN.skip || (!nodeMeetsEngines() && "the bootstrap refuses a Node outside package.json engines (>=24.16 <25 || >=26.1), so this leg needs a supported Node") }, async () => {
    const dir = makeTempDir("dist-dry-run-");
    const a = await packArtefact(dir, { real: true });
    const sb = createInstallerSandbox({ scenario: { recordNpmIntegrityByVersion: a.integrity } });
    // the shim's install record points here (fixture inspect-installed.json); a real MemoryDB lives in the plugin checkout
    const installPath = join(sb.stateDir, "npm", "projects", "cyb3rb1ade-plur1bus-memory-1ff39c963c", "node_modules", "@cyb3rb1ade", "plur1bus-memory");
    mkdirSync(dirname(installPath), { recursive: true });
    symlinkSync(PLUGIN.dir, installPath, "dir");
    const feedDir = join(dir, "feed");
    await signFeedForCi({ artefacts: dir, outDir: feedDir });
    const summaryFile = join(dir, "summary.md");
    // the bootstrap needs a real node on PATH (the sandbox's `node` is a logging shim); openclaw stays the shim
    const realBin = join(dir, "real-bin");
    mkdirSync(realBin);
    symlinkSync(process.execPath, join(realBin, "node"));
    const env = { ...sb.env, PATH: `${realBin}:${sb.env.PATH}`, RUNNER_TEMP: sb.root };
    const r = spawnSync(process.execPath, [join(HELPERS, "ci-plugin-dist.mjs"), "installer", "--artefacts", dir, "--feed-dir", feedDir, "--bootstrap", "sh"], {
      env: { ...env, GITHUB_STEP_SUMMARY: summaryFile },
      encoding: "utf8",
      timeout: 600_000,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-6000));
    const installs = sb.openclawCalls().filter((c) => c[0] === "plugins" && c[1] === "install").map((c) => c[2]);
    const artefacts = join(sb.stateDir, "plur1bus-installer", "artefacts");
    assert.deepEqual(installs, [a.ciVersion, a.version, a.ciVersion, a.version].map((v) => `npm-pack:${join(artefacts, `${v}.tgz`)}`), "fresh -ci.0, forced failing update, rollback, update — all from the kept artefacts (T8-b)");
    assert.match(r.stdout, /FACT installer\.keptArtefact: \{"kept":"[^"]+","exists":true/);
    assert.match(r.stdout, /FACT bootstrap\.jsonByteIdentical\.sh: \{"same":true/);
    const md = readFileSync(summaryFile, "utf8");
    for (const want of [/store before \| 50 rows/, /forced failing update \| exit 1, rollback ok, store untouched \(not restored\), digest equal/, /update 7\.16\.11-ci\.0 → 7\.16\.11 \| exit 0 \(--offline\), digest equal, snapshots 1 → 2/, /uninstall \| exit 0, store kept/]) assert.match(md, want);
    assert.equal((await storeDigest({ baseDbPath: join(sb.stateDir, "memory", "lancedb-namespaced") })).rows, 50);

    // the driver refuses an instance outside the temp root before calling anything
    const before = sb.openclawCalls().length;
    const bad = spawnSync(process.execPath, [join(HELPERS, "ci-plugin-dist.mjs"), "installer", "--artefacts", dir, "--feed-dir", feedDir, "--bootstrap", "sh"], {
      env: { ...env, RUNNER_TEMP: join(sb.root, "elsewhere") },
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a disposable OpenClaw instance/);
    assert.equal(sb.openclawCalls().length, before);
  });
});

describe("plugin-dist workflow", () => {
  const wf = parseYaml(readFileSync(WORKFLOW, "utf8"));

  it("plugin-dist.yml parses and every uses: is pinned to a 40-hex SHA", () => {
    const uses = [];
    const walk = (node) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "uses") uses.push(v);
          walk(v);
        }
      }
    };
    walk(wf.jobs);
    assert.ok(uses.length >= 5, `found ${uses.length} uses:`);
    for (const u of uses) assert.match(u, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/, u);
    const text = readFileSync(WORKFLOW, "utf8");
    for (const line of text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) assert.match(line, /@[0-9a-f]{40} # v\d/, `pinned with a version comment: ${line.trim()}`);
  });

  it("plugin-dist.yml gets the plugin from the pin (checkout + npm ci + npm pack) or from a release tarball, and the pin sits in plugin-pin.json only", () => {
    const pin = JSON.parse(readFileSync(join(REPO, "plugin-pin.json"), "utf8"));
    assert.deepEqual(Object.keys(pin).sort(), ["commit", "repo"]);
    assert.equal(pin.repo, "Cyb3rb1ade/openclaw-plur1bus-memory");
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
    const text = readFileSync(WORKFLOW, "utf8");
    assert.ok(!text.includes(pin.commit), "the commit is read from plugin-pin.json, not repeated in the workflow");
    const steps = wf.jobs.pack.steps;
    const checkout = steps.find((s) => String(s.uses).startsWith("actions/checkout@") && s.with?.path === "plugin");
    assert.ok(checkout, "a checkout of the plugin repository");
    assert.equal(checkout.with.repository, pin.repo);
    assert.equal(checkout.with.path, "plugin");
    assert.equal(checkout.with.ref, "${{ steps.pin.outputs.commit }}");
    assert.equal(checkout.with["persist-credentials"], false);
    assert.equal(checkout.if, "inputs.plugin-version == ''");
    const read = steps.find((s) => s.id === "pin").run;
    assert.match(read, /plugin-pin\.json/);
    const obtain = steps.find((s) => s.id === "tgz").run;
    assert.match(obtain, /cd plugin\n\s+npm ci --ignore-scripts[^\n]*\n\s+npm pack --json/);
    assert.match(obtain, /gh release download "v\$PLUGIN_VERSION" --repo "\$PLUGIN_REPO"/);
    assert.match(obtain, /sha256sum -c tgz\.sha256/);
    assert.ok(!/GITHUB_REPOSITORY/.test(text), "no step reads a release of this repository as the plugin");
  });

  it("plugin-dist.yml builds the Hermes provider from harness-pin.json when HM2_SIDECAR_RELEASED is not true", () => {
    const pin = JSON.parse(readFileSync(join(REPO, "harness-pin.json"), "utf8"));
    assert.deepEqual(Object.keys(pin).sort(), ["commit", "repo"]);
    assert.equal(pin.repo, "Cyb3rb1ade/PLUR1BUS-Harness");
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
    const text = readFileSync(WORKFLOW, "utf8");
    assert.ok(!text.includes(pin.commit), "the harness commit is read from harness-pin.json, not repeated in the workflow");
    const steps = wf.jobs.pack.steps;
    const read = steps.find((s) => s.id === "harness").run;
    assert.match(read, /harness-pin\.json/);
    const checkout = steps.find((s) => String(s.uses).startsWith("actions/checkout@") && s.with?.path === "harness");
    assert.ok(checkout, "a checkout of the harness repository");
    assert.equal(checkout.with.repository, pin.repo);
    assert.equal(checkout.with.ref, "${{ steps.harness.outputs.commit }}");
    assert.equal(checkout.with["persist-credentials"], false);
    assert.equal(checkout.if, "vars.HM2_SIDECAR_RELEASED != 'true'");
    const build = steps.find((s) => s.name === "Build the Hermes provider from source (TEST ONLY)");
    assert.equal(build.if, "vars.HM2_SIDECAR_RELEASED != 'true'");
    assert.match(build.run, /node harness\/scripts\/build-hermes-provider\.mjs --out/);
    assert.match(build.run, /hermes-ci\.json/);
    assert.ok(!/scripts\/dist\/installer/.test(build.run), "the installer is not invoked to build the provider");
  });

  it("plugin-dist.yml has the triggers, permissions and the ten-leg install matrix of the brief", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.ok(!("push" in wf.on), "no own tag trigger: addons-release.yml calls it");
    assert.ok("workflow_call" in wf.on && "pull_request" in wf.on);
    assert.equal(wf.on.schedule[0].cron, "17 3 * * *");
    assert.ok("workflow_dispatch" in wf.on);
    assert.equal(wf.on.workflow_dispatch.inputs.only.default, "");
    for (const p of ["scripts/dist/**", "vendor/**", ".github/workflows/plugin-dist.yml", "package*.json", "plugin-pin.json", "harness-pin.json"]) {
      assert.ok(wf.on.pull_request.paths.includes(p), p);
    }
    for (const p of wf.on.pull_request.paths) assert.ok(!/^lib\/|openclaw\.plugin\.json/.test(p), `${p} belongs to the plugin repository`);
    assert.equal(wf.on.workflow_call.inputs["plugin-version"].default, "");
    assert.equal(wf.on.workflow_call.outputs.artifact.value, "${{ jobs.pack.outputs.artifact }}");
    assert.equal(wf.jobs.pack["runs-on"], "ubuntu-24.04");
    const m = wf.jobs.install.strategy;
    assert.equal(m["fail-fast"], false);
    assert.deepEqual(m.matrix.runner, ["ubuntu-24.04", "ubuntu-24.04-arm", "macos-15", "windows-2025", "windows-11-arm"]);
    assert.deepEqual(m.matrix.openclaw, ["min", "latest"]);
    assert.match(String(wf.jobs.install.if), /workflow_dispatch/);
    assert.equal(
      wf.jobs.install["continue-on-error"],
      "${{ matrix.openclaw == 'latest' && (matrix.runner == 'ubuntu-24.04' || matrix.runner == 'ubuntu-24.04-arm') }}",
      "OpenClaw latest continue-on-error is only the two Linux legs (sharp/libvips after plugin-source-capture-path.ts)",
    );
    assert.deepEqual(wf.jobs.install.needs, "pack");
    assert.equal(wf.jobs.wsl["runs-on"], "windows-2025");
    assert.equal(wf.jobs.wsl["continue-on-error"], true);
    assert.equal(wf.jobs["upgrade-from-release"]["continue-on-error"], true);
    assert.match(wf.jobs["upgrade-from-release"].if, /schedule/);
    assert.match(wf.jobs["upgrade-from-release"].if, /workflow_dispatch/);
    const upgradeDownload = wf.jobs["upgrade-from-release"].steps.find((s) => /newest GitHub Release tarball/.test(s.name ?? ""));
    assert.match(upgradeDownload.run, /cyb3rb1ade-plur1bus-memory-\.\+\\.tgz/);
    assert.match(upgradeDownload.run, /plur1bus-\.\+\\.tgz/);
    assert.match(upgradeDownload.run, /neither cyb3rb1ade-plur1bus-memory-\*\.tgz nor plur1bus-\*\.tgz/);
    assert.match(
      upgradeDownload.run,
      /\{ grep -E '\^cyb3rb1ade-plur1bus-memory-\.\+\\.tgz\$' \|\| true; \}/,
      "a missing npm-pack name must not abort under pipefail before the plur1bus-*.tgz fallback",
    );
    const upgradeBody = wf.jobs["upgrade-from-release"].steps.find((s) => s.name === "Upgrade the release to the pack through the installer (store digest equal)");
    assert.equal(upgradeBody.if, "env.RELEASE_VERSION != needs.pack.outputs.version");
    const text = readFileSync(WORKFLOW, "utf8");
    assert.match(text, /src\/plugins\/plugin-source-capture-path\.ts/);
    assert.match(text, /Remove when fixed upstream or when the plugin degrades \(Part 2\)/);
    assert.match(text, /Vampire\/setup-wsl@[0-9a-f]{40} # v\d/);
    assert.ok(!/secrets\./.test(text), "the workflow uses no secrets");
    // every install leg asserts disposability right after installing OpenClaw
    const steps = wf.jobs.install.steps.map((s) => s.name ?? s.uses ?? "");
    const installIdx = steps.findIndex((n) => /Install OpenClaw \(POSIX/.test(n));
    const assertIdx = steps.findIndex((n) => /assert-disposable/i.test(n));
    assert.ok(installIdx >= 0 && assertIdx > installIdx, steps.join(" | "));
    assert.ok(steps.slice(installIdx + 1, assertIdx).every((n) => /Install OpenClaw/.test(n)), "assert-disposable is the first step after the OpenClaw install");
  });
});

describe("plugin-dist Hermes legs (HM2 Task 11)", () => {
  const wf = parseYaml(readFileSync(WORKFLOW, "utf8"));
  const text = readFileSync(WORKFLOW, "utf8");

  it("plugin-dist.yml parses, pins every action by SHA, and every Hermes leg sets PLUR1BUS_PLUGIN_TEST_NO_SERVICE", () => {
    for (const job of ["build-sidecar", "hermes", "hermes-wsl", "node-pins"]) assert.ok(wf.jobs[job], `job ${job}`);
    for (const job of ["build-sidecar", "hermes", "hermes-wsl", "node-pins"]) {
      for (const st of wf.jobs[job].steps) if (st.uses) assert.match(st.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/, `${job}: ${st.uses}`);
    }
    for (const job of ["hermes", "hermes-wsl"]) {
      assert.equal(wf.jobs[job].env.PLUR1BUS_PLUGIN_TEST_NO_SERVICE, "1", job);
      assert.equal(wf.jobs[job].env.PLUR1BUS_PLUGIN_INSTALLER_TEST, "1", job);
    }
    // Sidecar is built from source: Hermes legs must pass. The OpenClaw wsl leg stays C8.
    assert.equal(wf.jobs.hermes["continue-on-error"], undefined);
    assert.equal(wf.jobs["hermes-wsl"]["continue-on-error"], undefined);
    const m = wf.jobs.hermes.strategy;
    assert.equal(m["fail-fast"], false);
    assert.deepEqual(m.matrix.runner, ["ubuntu-24.04", "macos-15", "windows-2025"]);
    assert.deepEqual(m.matrix.hermes, ["min", "latest"]);
    assert.deepEqual(m.matrix.include.map((x) => [x.hermes, x["hermes-commit"], x["previous-provider"] ?? null]), [["min", "743ee72596e7a9f23bc7cd5c570a6ebd958043e4", null], ["latest", "f97608f178d1ffeca59860195ab7da295f7c8e5f", "builtin"]]);
    // both Hermes jobs refuse to run outside an ephemeral GitHub-hosted runner where they touch the profile
    assert.ok(wf.jobs["hermes-wsl"].steps.some((s) => s.if === "runner.environment != 'github-hosted'"), "hermes-wsl guard");
    assert.ok(wf.jobs.hermes.steps.some((s) => /runner\.environment != 'github-hosted'/.test(s.if ?? "")), "hermes guard");
    // POSIX: HOME and XDG_* are disposable for every step that runs Hermes or the installer
    for (const name of ["Install Hermes ${{ matrix.hermes }} (POSIX)", "hermes --version", "Bootstrap --host hermes (install, memory status, selftest, up-to-date re-run, uninstall)"]) {
      assert.match(wf.jobs.hermes.steps.find((s) => s.name === name).run, /\. "\$RUNNER_TEMP\/fake-env\.sh"/, name);
    }
    assert.match(wf.jobs.hermes.steps.find((s) => /assert-disposable/.test(s.name ?? "")).run, /--var XDG_CONFIG_HOME --var XDG_DATA_HOME --var XDG_STATE_HOME --var XDG_CACHE_HOME/);
    assert.equal(wf.jobs.hermes.env.PLUR1BUS_TEST_INTERNALS, "flat-embedder", "no model download (F21)");
    assert.equal(wf.jobs["hermes-wsl"]["runs-on"], "windows-2025");
    // assert-disposable --host hermes is the first step after installing Hermes
    const names = wf.jobs.hermes.steps.map((s) => s.name ?? s.uses ?? "");
    const lastInstall = names.map((n, i) => (/^Install Hermes/.test(n) ? i : -1)).filter((i) => i >= 0).pop();
    assert.ok(/assert-disposable/.test(names[lastInstall + 1]), names.join(" | "));
    assert.match(wf.jobs.hermes.steps[lastInstall + 1].run, /assert-disposable\.mjs --host hermes/);
    // Windows: step-scoped GIT_CONFIG_GLOBAL with autocrlf off before Hermes' install.ps1 (harness 4eea755)
    const winInstall = wf.jobs.hermes.steps.find((s) => s.name === "Install Hermes ${{ matrix.hermes }} (Windows)");
    assert.match(winInstall.env.GIT_CONFIG_GLOBAL, /runner\.temp/);
    assert.match(winInstall.run, /autocrlf = false/);
    assert.ok(winInstall.run.indexOf("Set-Content") < winInstall.run.indexOf("hermes-install.ps1"));
    // the bootstrap runs with --host hermes (sh) / -Host hermes (ps1) through the driver
    assert.match(text, /ci-hermes-dist\.mjs install .*--bootstrap ps1/);
    assert.match(text, /ci-hermes-dist\.mjs install .*--bootstrap sh/);
    assert.match(text, /ci-hermes-dist\.mjs wsl-install --distro Ubuntu-24.04/);
    const nativeSign = wf.jobs.hermes.steps.find((s) => /sign-feed-for-ci\.mjs/.test(s.run ?? ""));
    const wslSign = wf.jobs["hermes-wsl"].steps.find((s) => /sign-feed-for-ci\.mjs/.test(s.run ?? ""));
    assert.doesNotMatch(nativeSign.run, /wsl-file-urls/);
    assert.match(wslSign.run, /--wsl-file-urls/);
    assert.match(wf.jobs["node-pins"].steps.at(-1).run, /nodejs\.org\/dist\/v\$v\/SHASUMS256\.txt/);
    assert.ok(!/secrets\./.test(text), "the workflow uses no secrets");
    for (const job of ["hermes", "hermes-wsl"]) {
      assert.deepEqual(wf.jobs[job].needs, ["pack", "build-sidecar"], job);
      assert.match(String(wf.jobs[job].if), /always\(\)/);
      assert.match(String(wf.jobs[job].if), /needs\.build-sidecar\.result == 'success'/);
      assert.match(String(wf.jobs[job].if), /needs\.build-sidecar\.result == 'skipped'/);
      const dl = wf.jobs[job].steps.find((s) => s.name === "Download the sidecar artefacts");
      assert.equal(dl.if, "vars.HM2_SIDECAR_RELEASED != 'true'", job);
      assert.equal(dl.with.pattern, "sidecar-*");
      assert.equal(dl.with["merge-multiple"], true);
    }
  });

  it("plugin-dist.yml builds the sidecar from harness-pin.json when HM2_SIDECAR_RELEASED is not true", () => {
    const pin = JSON.parse(readFileSync(join(REPO, "harness-pin.json"), "utf8"));
    const job = wf.jobs["build-sidecar"];
    assert.match(String(job.if), /HM2_SIDECAR_RELEASED != 'true'/);
    assert.match(String(job.if), /workflow_dispatch/);
    assert.equal(job.strategy["fail-fast"], false);
    assert.deepEqual(
      job.strategy.matrix.include.map((x) => [x.target, x.runner]),
      [
        ["linux-x64", "ubuntu-24.04"],
        ["linux-arm64", "ubuntu-24.04-arm"],
        ["darwin-arm64", "macos-15"],
        ["win-x64", "windows-2025"],
      ],
    );
    const checkout = job.steps.find((s) => String(s.uses).startsWith("actions/checkout@") && s.with?.path === "harness");
    assert.equal(checkout.with.repository, pin.repo);
    assert.equal(checkout.with.ref, "${{ steps.harness.outputs.commit }}");
    assert.equal(checkout.with["persist-credentials"], false);
    const rust = job.steps.find((s) => String(s.uses).startsWith("dtolnay/rust-toolchain@"));
    assert.equal(rust.with.toolchain, "1.95");
    assert.ok(job.steps.some((s) => String(s.uses).startsWith("Swatinem/rust-cache@")));
    const build = job.steps.find((s) => s.name === "Build the sidecar and core payload (TEST ONLY)");
    assert.match(build.run, /cargo build --locked --release -p plur1bus/);
    assert.match(build.run, /assemble-payload\.mjs --target/);
    assert.match(build.run, /createHash\('sha256'\)/);
    assert.match(build.run, /process\.env\.CORE_PAYLOAD/);
    assert.doesNotMatch(build.run, /sha256sum /);
    assert.match(build.run, /PLUR1BUS_RELEASE_BASE_URL="file:\/\/\/tmp\/plur1bus-ci-core"/);
    assert.match(build.run, /PLUR1BUS_RELEASE_BASE_URL="file:\/\/\/D:\/a\/_temp\/plur1bus-ci-core"/);
    assert.ok(!/scripts\/dist\/installer/.test(build.run), "the installer is not invoked to build the sidecar");
    const place = wf.jobs.hermes.steps.find((s) => s.name === "Place the TEST-ONLY core payload where the sidecar looks");
    assert.equal(place.if, "vars.HM2_SIDECAR_RELEASED != 'true'");
    assert.match(place.run, /\/tmp\/plur1bus-ci-core/);
    assert.match(place.run, /find "\$dir" -maxdepth 1 -type f -name "core-\*-\$t\.tar\.gz"/);
    assert.match(place.run, /cygpath -u/);
    assert.doesNotMatch(place.run, /set -- \$src/);
    const wslPlace = wf.jobs["hermes-wsl"].steps.find((s) => s.name === "Place the TEST-ONLY core payload inside WSL");
    assert.equal(wslPlace.if, "vars.HM2_SIDECAR_RELEASED != 'true'");
    assert.match(wslPlace.run, /\/tmp\/plur1bus-ci-core/);
    assert.match(wslPlace.run, /find "\$dir" -maxdepth 1 -type f -name "core-\*-linux-x64\.tar\.gz"/);
    assert.match(wslPlace.run, /cygpath -w "\$src"/);
    assert.match(wslPlace.run, /wslpath -a "\$win_src"/);
    assert.doesNotMatch(wslPlace.run, /set -- \$src/);
    assert.doesNotMatch(wslPlace.run, /wslpath -a "\$src"/);
  });

  it("the CI feed carries hosts.hermes from the lock (a placeholder lock is accepted only here)", async () => {
    const dir = makeTempDir("ci-feed-hermes-");
    await packArtefact(dir);
    const out = join(dir, "feed");
    const r = await signFeedForCi({ artefacts: dir, outDir: out });
    const feed = JSON.parse(readFileSync(r.feedFile, "utf8"));
    const lock = JSON.parse(readFileSync(join(REPO, "scripts", "dist", "hermes-sidecar.lock.json"), "utf8"));
    assert.equal(feed.hosts.hermes.latest, lock.version);
    assert.deepEqual(feed.hosts.hermes.releases[0].provider, lock.provider);
    assert.deepEqual(validateFeed(feed, { allowFile: true }), { ok: true, errors: [] });
    assert.equal(r.hermes, lock.version);
    // --no-hermes: as before
    const none = await signFeedForCi({ artefacts: dir, outDir: join(dir, "feed2"), hermesLock: null });
    assert.equal(JSON.parse(readFileSync(none.feedFile, "utf8")).hosts.hermes, undefined);
  });

  it("the CI feed rewrites hosts.hermes.provider to the pack's built tarball when hermes-ci.json is present", async () => {
    const dir = makeTempDir("ci-feed-hermes-src-");
    await packArtefact(dir);
    const name = "plur1bus-hermes-provider-0.1.0.tar.gz";
    const bytes = Buffer.from("TEST ONLY hermes provider tarball\n");
    writeFileSync(join(dir, name), bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(dir, "hermes-ci.json"), JSON.stringify({ provider: { file: name, sha256 } }) + "\n");
    const r = await signFeedForCi({ artefacts: dir, outDir: join(dir, "feed") });
    const feed = JSON.parse(readFileSync(r.feedFile, "utf8"));
    const lock = JSON.parse(readFileSync(join(REPO, "scripts", "dist", "hermes-sidecar.lock.json"), "utf8"));
    assert.equal(feed.hosts.hermes.releases[0].provider.url, pathToFileURL(join(dir, name)).href);
    assert.equal(feed.hosts.hermes.releases[0].provider.sha256, sha256);
    assert.notEqual(feed.hosts.hermes.releases[0].provider.url, lock.provider.url);
    assert.deepEqual(feed.hosts.hermes.releases[0].sidecar.binary, lock.binary);
    assert.deepEqual(validateFeed(feed, { allowFile: true }), { ok: true, errors: [] });
    assert.equal(windowsFileUrlAsWsl("file:///D:/a/_temp/plugin-dist/plur1bus-hermes-provider-0.1.0.tar.gz"), "file:///mnt/d/a/_temp/plugin-dist/plur1bus-hermes-provider-0.1.0.tar.gz");
    assert.throws(() => windowsFileUrlAsWsl("file:///tmp/plugin-dist/plur1bus-hermes-provider-0.1.0.tar.gz"), /not a Windows file URL/);
    assert.throws(() => windowsFileUrlAsWsl("file:///D:/a/../secret.tgz"), /not a Windows file URL/);
    const sidecarUrl = lock.binary["linux-x64"].url;
    const wslFeed = { hosts: { hermes: { releases: [{ provider: { url: "file:///D:/a/_temp/plugin-dist/plur1bus-hermes-provider-0.1.0.tar.gz", sha256 }, sidecar: { url: sidecarUrl, binary: { "linux-x64": { url: sidecarUrl, sha256: lock.binary["linux-x64"].sha256 } } } }] } } };
    rewriteHermesProviderUrlsForWsl(wslFeed);
    assert.equal(wslFeed.hosts.hermes.releases[0].provider.url, "file:///mnt/d/a/_temp/plugin-dist/plur1bus-hermes-provider-0.1.0.tar.gz");
    assert.equal(wslFeed.hosts.hermes.releases[0].provider.sha256, sha256);
    assert.equal(wslFeed.hosts.hermes.releases[0].sidecar.url, sidecarUrl);
    assert.equal(wslFeed.hosts.hermes.releases[0].sidecar.binary["linux-x64"].url, sidecarUrl, "https sidecar URLs stay on the lock");
  });

  it("the CI feed rewrites hosts.hermes.sidecar.binary to built files in the artefact directory", async () => {
    const dir = makeTempDir("ci-feed-sidecar-src-");
    await packArtefact(dir);
    const linux = Buffer.from("TEST ONLY linux-x64 sidecar\n");
    const win = Buffer.from("TEST ONLY win-x64 sidecar\n");
    writeFileSync(join(dir, "plur1bus-linux-x64"), linux);
    writeFileSync(join(dir, "plur1bus-win-x64.exe"), win);
    const r = await signFeedForCi({ artefacts: dir, outDir: join(dir, "feed") });
    const feed = JSON.parse(readFileSync(r.feedFile, "utf8"));
    const lock = JSON.parse(readFileSync(join(REPO, "scripts", "dist", "hermes-sidecar.lock.json"), "utf8"));
    const linuxSha = createHash("sha256").update(linux).digest("hex");
    const winSha = createHash("sha256").update(win).digest("hex");
    assert.equal(feed.hosts.hermes.releases[0].sidecar.binary["linux-x64"].url, pathToFileURL(join(dir, "plur1bus-linux-x64")).href);
    assert.equal(feed.hosts.hermes.releases[0].sidecar.binary["linux-x64"].sha256, linuxSha);
    assert.equal(feed.hosts.hermes.releases[0].sidecar.binary["win-x64"].url, pathToFileURL(join(dir, "plur1bus-win-x64.exe")).href);
    assert.equal(feed.hosts.hermes.releases[0].sidecar.binary["win-x64"].sha256, winSha);
    assert.deepEqual(feed.hosts.hermes.releases[0].sidecar.binary["win-arm64"], lock.binary["win-arm64"], "targets without a built file stay on the lock");
    assert.deepEqual(feed.hosts.hermes.releases[0].sidecar.binary["linux-arm64"], lock.binary["linux-arm64"]);
    assert.deepEqual(validateFeed(feed, { allowFile: true }), { ok: true, errors: [] });
    const wslFeed = JSON.parse(JSON.stringify(feed));
    wslFeed.hosts.hermes.releases[0].sidecar.binary["linux-x64"].url = "file:///D:/a/_temp/plugin-dist/plur1bus-linux-x64";
    rewriteHermesProviderUrlsForWsl(wslFeed);
    assert.equal(wslFeed.hosts.hermes.releases[0].sidecar.binary["linux-x64"].url, "file:///mnt/d/a/_temp/plugin-dist/plur1bus-linux-x64");
    assert.equal(wslFeed.hosts.hermes.releases[0].sidecar.binary["win-arm64"].url, lock.binary["win-arm64"].url);
    const empty = { hosts: { hermes: { releases: [{ sidecar: { binary: JSON.parse(JSON.stringify(lock.binary)) } }] } } };
    rewriteHermesSidecarFromArtefacts(empty, dir);
    assert.equal(empty.hosts.hermes.releases[0].sidecar.binary["linux-x64"].sha256, linuxSha);
  });

  it("assert-disposable --host hermes checks HERMES_HOME and PLUR1BUS_HOME", () => {
    const rt = makeTempDir("runner-temp-");
    const ok = assertDisposable({ host: "hermes", env: { RUNNER_TEMP: rt, HERMES_HOME: join(rt, "hh"), PLUR1BUS_HOME: join(rt, "p1b") } });
    assert.equal(ok.ok, true, ok.errors.join("; "));
    const bad = assertDisposable({ host: "hermes", env: { RUNNER_TEMP: rt, HERMES_HOME: join(REPO, "hh"), PLUR1BUS_HOME: join(rt, "p1b") } });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join("\n"), /HERMES_HOME/);
    assert.throws(() => assertDisposable({ host: "claude", env: {} }), /unknown host/);
    const cli = spawnSync(process.execPath, [join(HELPERS, "assert-disposable.mjs"), "--host", "hermes"], { env: { ...process.env, RUNNER_TEMP: rt, HERMES_HOME: "/etc", PLUR1BUS_HOME: join(rt, "p1b") }, encoding: "utf8" });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Hermes is not disposable/);
  });

  it("the Hermes driver passes only the test seams and the CI-signed feed, and reads the last JSON document", () => {
    const dir = makeTempDir("ci-hermes-env-");
    writeFileSync(join(dir, "pubkey.txt"), "RWTEST ONLY\n");
    const env = bootstrapEnv({ PATH: "/x" }, dir);
    assert.equal(env.PLUR1BUS_PLUGIN_TEST_NO_SERVICE, "1");
    assert.equal(env.PLUR1BUS_PLUGIN_INSTALLER_TEST, "1");
    assert.equal(env.PLUR1BUS_PLUGIN_FEED, pathToFileURL(join(dir, "stable.json")).href);
    assert.equal(env.PLUR1BUS_PLUGIN_PUBKEY, "RWTEST ONLY");
    assert.deepEqual(lastJson('noise\n{"ok":true}\n'), { ok: true });
    assert.equal(lastJson('"plur1bus"\n'), "plur1bus");
    assert.equal(lastJson("nothing"), undefined);
    // the re-run must be ok and its update step must say up-to-date (not just mention it somewhere)
    assert.equal(isUpToDate({ ok: true, steps: [{ id: "update", status: "ok", detail: "up-to-date: plur1bus 0.1.0 (sidecar 0.1.0)" }] }), true);
    assert.equal(isUpToDate({ ok: false, steps: [{ id: "update", status: "ok", detail: "up-to-date: x" }] }), false);
    assert.equal(isUpToDate({ ok: true, steps: [{ id: "setup", status: "ok", detail: "up-to-date" }, { id: "update", status: "ok", detail: "updated to 0.2.0" }] }), false);
  });

  it("check-node-pins compares node-pins.json with SHASUMS256.txt and the lock's nodeVersion (F33)", () => {
    const pins = JSON.parse(readFileSync(join(REPO, "scripts", "dist", "node-pins.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(REPO, "scripts", "dist", "hermes-sidecar.lock.json"), "utf8"));
    const sums = Object.entries(pins.targets).map(([t, p]) => `${p.sha256}  node-v${pins.version}-${t}.${p.archive}`).concat(["0".repeat(64) + "  node-v24.21.0.tar.gz"]).join("\n");
    assert.equal(parseShasums(sums).size, 6);
    assert.deepEqual(comparePins({ pins, shasums: sums, lock }), { ok: true, errors: [], checked: ["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"] });
    const tampered = sums.replace(pins.targets["win-arm64"].sha256, "e".repeat(64));
    assert.match(comparePins({ pins, shasums: tampered }).errors.join("\n"), /win-arm64: node-pins\.json says/);
    assert.match(comparePins({ pins, shasums: sums, lock: { ...lock, nodeVersion: "24.22.0" } }).errors.join("\n"), /F33/);
    assert.match(comparePins({ pins, shasums: "" }).errors.join("\n"), /not in SHASUMS256/);
  });
});
