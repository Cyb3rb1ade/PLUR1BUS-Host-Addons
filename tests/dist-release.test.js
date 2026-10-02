// tests/dist-release.test.js — HM1 Task 10 (split into the add-on repository): version consistency, the release workflow's
// static contract (.github/workflows/addons-release.yml), the release notes.
// Local only: reads repository files, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { DEFAULT_NODE_PINS, renderBootstraps, renderInstallerKeys } from "../scripts/dist/render-bootstraps.mjs";
import { generateTestKeyPair } from "./helpers/minisign-sign.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(REPO, ".github", "workflows", "addons-release.yml");
const text = readFileSync(WORKFLOW, "utf8");
const readJson = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

describe("add-ons release (HM1 Task 10, split)", () => {
  it("package.json and the lockfile agree on the add-on version; the plugin versions it installs are the feed's business", () => {
    const pkg = readJson("package.json");
    const lock = readJson("package-lock.json");
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.private, true, "never published to npm");
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""].version, pkg.version);
    assert.equal(pkg.version, "0.1.0", "the add-on repository's own version line starts at 0.1.0");
    assert.ok(!existsSync(join(REPO, "openclaw.plugin.json")), "the plugin manifest is the plugin repository's");
    const pin = readJson("plugin-pin.json");
    assert.equal(pin.repo, "Cyb3rb1ade/openclaw-plur1bus-memory");
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
  });

  it("the release workflow passes the hermes lock and node pins", () => {
    const feedStep = text.slice(text.indexOf("- name: Build the unsigned feed"), text.indexOf("- name: Write SHA256SUMS"));
    assert.match(feedStep, /args\+=\(--hermes-lock "\$lock" --hermes-notes-de "docs\/release-notes\/\$ADDONS_VERSION\.de\.md" --hermes-notes-en "docs\/release-notes\/\$ADDONS_VERSION\.en\.md"\)/);
    assert.match(feedStep, /lock=scripts\/dist\/hermes-sidecar\.lock\.json/);
    // I3(b): a placeholder lock never blocks a release, dry or real: no --hermes-lock, a warning in the log and the
    // job summary (the builder itself still refuses a placeholder passed to it, F31)
    const gate = /if node -e '[^']*placeholder === true \? 0 : 1\)' "\$lock"; then\n([\s\S]*?)\n\s*else\n([\s\S]*?)\n\s*fi/.exec(feedStep);
    assert.ok(gate, "the placeholder gate");
    assert.ok(!/DRY_RUN/.test(gate[0]), "the same in a dry and a real run");
    assert.match(gate[1], /::warning title=Hermes host omitted::/);
    assert.match(gate[1], />> "\$GITHUB_STEP_SUMMARY"/);
    assert.ok(!gate[1].includes("--hermes-lock"));
    assert.match(gate[2], /--hermes-lock "\$lock"/);
    const renders = text.split("\n").filter((l) => /render-bootstraps\.mjs/.test(l));
    assert.equal(renders.length, 2);
    for (const l of renders) assert.match(l, /--node-pins scripts\/dist\/node-pins\.json/, l);
  });

  it("0.1.0 notes exist in de and en and the docs describe Hermes host mode", () => {
    for (const lang of ["de", "en"]) assert.ok(existsSync(join(REPO, "docs", "release-notes", `0.1.0.${lang}.md`)), lang);
    assert.deepEqual(readdirSync(join(REPO, "docs", "release-notes")).sort(), ["0.1.0.de.md", "0.1.0.en.md"], "no plugin-version notes here");
    const dist = readFileSync(join(REPO, "docs", "distribution.md"), "utf8");
    for (const s of ["## Hermes host mode (HM2)", "%LOCALAPPDATA%\\hermes", "provider-in-use", "purge-refused", "journal.ndjson", "Node 24.21.0", "--replace-provider", "--hermes-profile"]) {
      assert.ok(dist.includes(s), `docs/distribution.md mentions ${s}`);
    }
    assert.ok(!dist.includes("host-not-yet-supported"), "the HM1 refusal is gone");
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    assert.ok(readme.includes("install-plugin.sh | sh -s -- --host hermes"));
    assert.ok(readme.includes("-Host hermes"));
    assert.match(readFileSync(join(REPO, "CHANGELOG.md"), "utf8"), /^## \[0\.1\.0\] — unreleased/m);
  });

  it("addons-release.yml parses and pins every action to a SHA", () => {
    const wf = parseYaml(text);
    assert.ok(!("push" in wf.on), "no tag trigger: the plugin version to release against is an input");
    assert.equal(wf.on.workflow_dispatch.inputs["plugin-version"].required, true);
    assert.equal(wf.on.workflow_dispatch.inputs["dry-run"].default, true);
    assert.equal(wf.on.workflow_dispatch.inputs.channel.default, "stable");
    assert.deepEqual(wf.permissions, { contents: "read" });
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
    assert.ok(uses.length >= 6, `found ${uses.length} uses:`);
    for (const u of uses) {
      if (u.startsWith("./")) assert.equal(u, "./.github/workflows/plugin-dist.yml");
      else assert.match(u, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/, u);
    }
    for (const line of text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l) && !l.includes("./.github/"))) {
      assert.match(line, /@[0-9a-f]{40} # v\d/, `pinned with a version comment: ${line.trim()}`);
    }
    // No secret is referenced: only the automatic token; npm publishes through OIDC trusted publishing.
    assert.equal([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].length, 0, "no secrets.* reference");
    assert.ok(!/NODE_AUTH_TOKEN|NPM_TOKEN/.test(text.replace(/^\s*#.*$/gm, "")), "no npm token");
    assert.ok(!/npm publish/.test(text.replace(/^\s*#.*$/gm, "")), "the npm publish stays in the plugin repository");
    assert.ok(!/minisign\s+-S|\.key\b/.test(text.replace(/^\s*#.*$/gm, "")), "the feed is never signed in CI");
  });

  it("addons-release.yml grants id-token and attestations only where needed", () => {
    const wf = parseYaml(text);
    assert.deepEqual(Object.keys(wf.jobs), ["check", "dist", "assemble", "attest", "github-release", "npm-check"]);
    assert.equal(wf.jobs.dist.uses, "./.github/workflows/plugin-dist.yml");
    assert.equal(wf.jobs.dist.with["plugin-version"], "${{ needs.check.outputs.plugin-version }}", "dist installs the plugin release's own tarball");
    for (const [name, job] of Object.entries(wf.jobs)) {
      const p = job.permissions ?? {};
      if (name === "assemble") assert.deepEqual(p, { contents: "read" });
      else if (name === "attest") assert.deepEqual(p, { contents: "read", "id-token": "write", attestations: "write" });
      else if (name === "github-release") assert.deepEqual(p, { contents: "write" });
      else if (name === "npm-check") assert.deepEqual(p, { contents: "read" });
      else assert.ok(!("id-token" in p) && !("attestations" in p), `${name} needs neither`);
    }
    assert.equal(wf.jobs["npm-check"].environment, undefined, "no publish environment here");
    // attestations are real-run only and follow assemble; the release waits for them
    assert.match(wf.jobs.attest.if, /dry-run != 'true'/);
    assert.ok(wf.jobs.attest.needs.includes("assemble") && wf.jobs["github-release"].needs.includes("attest"));
    // the npm decision is made once, in assemble
    assert.equal(wf.jobs["npm-check"].if.includes("vars."), false);
    assert.match(wf.jobs["npm-check"].if, /needs\.assemble\.outputs\.npm == 'yes'/);
    assert.equal((text.match(/vars\.PLUR1BUS_NPM_PUBLISH/g) ?? []).length, 1);
  });

  it("addons-release.yml: plugin tarball from the plugin release, add-on artefacts only in SHA256SUMS and on the release, credentials not persisted", () => {
    const wf = parseYaml(text);
    const check = wf.jobs.check.steps.find((s) => s.id === "check").run;
    assert.match(check, /plugin-version '\$INPUT_PLUGIN_VERSION' is not x\.y\.z/);
    assert.match(check, /a real release runs on the tag v\$pkg/);
    assert.match(check, /docs\/release-notes\/\$pkg\.\$lang\.md/);
    // installer, bootstraps and notes are this repository's; the tarball is the plugin release's
    assert.match(text, /PLUGIN_RELEASE_BASE: https:\/\/github\.com\/Cyb3rb1ade\/openclaw-plur1bus-memory\/releases\/download/);
    assert.match(text, /ADDONS_RELEASE_BASE: https:\/\/github\.com\/Cyb3rb1ade\/PLUR1BUS-Host-Addons\/releases\/download/);
    const feed = wf.jobs.assemble.steps.find((s) => s.name === "Build the unsigned feed").run;
    assert.match(feed, /--tarball-url "\$plugin_base\/cyb3rb1ade-plur1bus-memory-\$VERSION\.tgz"/);
    assert.match(feed, /--installer-url "\$base\/plur1bus-plugin-installer\.mjs"/);
    assert.match(feed, /--bootstrap-sh-url "\$base\/install-plugin\.sh"/);
    assert.match(feed, /--notes-de "docs\/release-notes\/\$ADDONS_VERSION\.de\.md" --notes-en "docs\/release-notes\/\$ADDONS_VERSION\.en\.md"/);
    const create = wf.jobs["github-release"].steps.find((s) => s.name === "Create the release").run;
    assert.match(create, /gh release create "v\$ADDONS_VERSION"/);
    assert.ok(!/\.tgz/.test(create), "the plugin tarball is not an asset of this repository's release");
    assert.ok(!/plur1bus-memory-/.test(wf.jobs.attest.steps.map((s) => JSON.stringify(s.with ?? {})).join("")), "the plugin tarball is attested in the plugin repository");
    const npm = wf.jobs["npm-check"].steps.find((s) => /npm view/.test(s.run ?? "")).run;
    assert.match(npm, /npm view "@cyb3rb1ade\/plur1bus-memory@\$VERSION" dist\.integrity/);
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const step of job.steps ?? []) {
        if (String(step.uses).startsWith("actions/checkout@")) assert.equal(step.with?.["persist-credentials"], false, `${name}: checkout`);
      }
    }
    const sums = wf.jobs.assemble.steps.find((s) => s.name === "Write SHA256SUMS").run;
    assert.match(sums, /plur1bus-plugin-installer\.mjs install-plugin\.sh install-plugin\.ps1 "plugin-\$CHANNEL\.unsigned\.json" > SHA256SUMS/);
    assert.ok(!/sha256sum "cyb3rb1ade-plur1bus-memory/.test(sums), "the plugin tarball is not in this release's SHA256SUMS");
    assert.ok(!/"plugin-\$CHANNEL\.json" > SHA256SUMS/.test(sums));
    const stage = wf.jobs.assemble.steps.find((s) => s.name === "Stage the release files").run;
    assert.match(stage, /differs from pack\.json/);
    assert.match(stage, /p\.sha256/);
    assert.match(stage, /p\.integrity/);
  });

  it("ci.yml runs the suite on ubuntu-24.04, macos-15 and windows-2025 (node 24.21.0, python 3.13, lock interop required) plus the Windows bootstrap byte check", () => {
    const wf = parseYaml(readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8"));
    const job = wf.jobs.test;
    assert.deepEqual(job.strategy.matrix.os, ["ubuntu-24.04", "macos-15", "windows-2025"]);
    assert.equal(job["continue-on-error"], undefined, "every OS is required");
    assert.equal(job.strategy["fail-fast"], false);
    const node = job.steps.find((s) => String(s.uses).startsWith("actions/setup-node@"));
    assert.equal(node.with["node-version"], "24.21.0");
    const py = job.steps.find((s) => String(s.uses).startsWith("actions/setup-python@"));
    assert.equal(py.with["python-version"], "3.13");
    const run = job.steps.find((s) => s.run === "npm test");
    assert.equal(run.env.PLUR1BUS_REQUIRE_LOCK_INTEROP, "1");
    assert.ok(job.steps.some((s) => s.run === "npm ci"));
    const boot = wf.jobs["bootstrap-stdin-bytes"];
    assert.equal(boot["runs-on"], "windows-2025");
    const check = boot.steps.find((s) => /wsl:<d> pipes the verified sh/.test(s.run ?? ""));
    assert.equal(check.env.PLUR1BUS_REQUIRE_PS51, "1");
  });

  it("every checkout in every workflow sets persist-credentials: false", () => {
    const dir = join(REPO, ".github", "workflows");
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    for (const want of ["ci.yml", "addons-release.yml", "plugin-dist.yml"]) assert.ok(files.includes(want), want);
    let n = 0;
    for (const file of files) {
      const wf = parseYaml(readFileSync(join(dir, file), "utf8"));
      for (const [name, job] of Object.entries(wf.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!String(step.uses).startsWith("actions/checkout@")) continue;
          n += 1;
          assert.equal(step.with?.["persist-credentials"], false, `${file} ${name}: checkout`);
        }
      }
    }
    assert.ok(n >= 14, `found ${n} checkouts`);
  });

  it("assemble renders the channel keys into the installer bundle before the feed and SHA256SUMS (HM1-R-F1)", () => {
    const wf = parseYaml(text);
    const steps = wf.jobs.assemble.steps;
    const idx = (pred) => steps.findIndex(pred);
    const render = idx((s) => /render-bootstraps\.mjs/.test(s.run ?? ""));
    assert.ok(render >= 0, "a render step");
    const run = steps[render].run;
    assert.match(run, /bundle="\$out\/plur1bus-plugin-installer\.mjs"/);
    const calls = run.split("\n").filter((l) => /render-bootstraps\.mjs/.test(l));
    assert.equal(calls.length, 2, "release keys and dry-run TEST ONLY");
    for (const c of calls) assert.match(c, /--installer "\$bundle"/, c);
    assert.match(calls[0], /--pubkey-stable "\$PUBKEY_STABLE" --pubkey-beta "\$PUBKEY_BETA"/);
    assert.match(calls[1], /--test-key/);
    assert.match(run, /grep -q '@@PLUR1BUS_PLUGIN_PUBKEY_' "\$bundle"/);
    assert.match(run, /for f in "\$out\/install-plugin\.sh" "\$out\/install-plugin\.ps1" "\$bundle"/);
    assert.match(run, /if \[ "\$DRY_RUN" != true \] && \[ "\$test_key" = 1 \]; then .*exit 1; fi/);
    assert.ok(render < idx((s) => s.name === "Build the unsigned feed"), "render before the feed");
    assert.ok(render < idx((s) => s.name === "Write SHA256SUMS"), "render before SHA256SUMS");
    assert.ok(render > idx((s) => s.name === "Stage the release files"), "render after staging");

    // The marker the workflow greps is present in every TEST ONLY render and absent from every release render.
    const marker = /grep -qF '([^']+)' "\$f"/.exec(run)?.[1];
    assert.ok(marker, "the TEST ONLY marker grep");
    const raw = readFileSync(join(REPO, "scripts", "dist", "installer", "main.mjs"), "utf8");
    const stable = generateTestKeyPair().publicKeyLine;
    const beta = generateTestKeyPair().publicKeyLine;
    const release = renderBootstraps({ pubkeyStable: stable, pubkeyBeta: beta, nodePins: DEFAULT_NODE_PINS });
    const test = renderBootstraps({ testKey: true, nodePins: DEFAULT_NODE_PINS });
    for (const t of [release.sh, release.ps1, renderInstallerKeys(raw, { pubkeyStable: stable, pubkeyBeta: beta })]) {
      assert.ok(!t.includes(marker), "a release render carries no TEST ONLY marker");
      assert.ok(!t.includes("@@PLUR1BUS_PLUGIN_PUBKEY_"));
    }
    for (const t of [test.sh, test.ps1, renderInstallerKeys(raw, { testKey: true })]) assert.ok(t.includes(marker), "a TEST ONLY render carries the marker");
  });

  it("the release notes exist in de and en for the add-on version", () => {
    const { version } = readJson("package.json");
    for (const lang of ["de", "en"]) {
      const file = join(REPO, "docs", "release-notes", `${version}.${lang}.md`);
      assert.ok(existsSync(file), `${file} exists`);
      const text = readFileSync(file, "utf8");
      assert.ok(text.length <= 1500, `${lang} notes are ${text.length} characters (max 1500)`);
      assert.equal((text.match(/^## .+$/gm) ?? []).length, 3, `${lang}: three fixed headings`);
    }
    const en = readFileSync(join(REPO, "docs", "release-notes", `${version}.en.md`), "utf8");
    for (const h of ["What's new", "Fixes", "Upgrade notes"]) assert.ok(en.includes(`## ${h}\n`), h);
    const de = readFileSync(join(REPO, "docs", "release-notes", `${version}.de.md`), "utf8");
    for (const h of ["Neu", "Korrekturen", "Hinweise zum Upgrade"]) assert.ok(de.includes(`## ${h}\n`), h);
  });
});
