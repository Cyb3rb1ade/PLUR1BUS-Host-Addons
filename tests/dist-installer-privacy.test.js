// tests/dist-installer-privacy.test.js — installer privacy audit K6 M-1, M-2, M-4: URL tokens, the OS user name and
// third-party error text stay out of stdout, stderr, --json and the state files unless --verbose asks for the
// excerpt. Sandbox shims and fake `run`/`fetch` only, a temp HOME, hard timeouts; never a real OpenClaw or Hermes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { runInstaller, USAGE } from "../scripts/dist/installer/main.mjs";
import { createOpenclawCli, failureSummary } from "../scripts/dist/installer/openclaw-cli.mjs";
import { createPlur1busCli } from "../scripts/dist/installer/hermes/plur1bus-cli.mjs";
import { createHermesCli } from "../scripts/dist/installer/hermes/hermes-cli.mjs";
import { createReport, EXIT } from "../scripts/dist/installer/report.mjs";
import { publicLicence, redactUrl, redactUrls, scrubText, setVerbose, userHash } from "../scripts/dist/installer/redact.mjs";
import { createInstallerSandbox, runSandboxInstaller, sink } from "./helpers/installer-sandbox.js";

const TOKEN = "MARKERTOKEN9f3a1c";
const USER = "marker-user-xq7";
const BOUND = "MARKER_BEYOND_THE_BOUND";
const BEARER = "MARKERBEARER77aa";

/** Every regular file below `dir`, as { path, text }. */
function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...files(p));
    else if (st.size < 1 << 20) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

describe("redact: URLs, user hash, child text", { timeout: 120_000 }, () => {
  it("redactUrl keeps scheme, host and a plain file name and hashes the rest", () => {
    const r = redactUrl(`https://user:pw@mirror.example/t/${TOKEN}/stable.json?sig=${TOKEN}#frag`);
    assert.match(r, /^https:\/\/mirror\.example\/…\/stable\.json#h=[0-9a-f]{8}$/);
    assert.doesNotMatch(r, new RegExp(`${TOKEN}|user|pw|frag`));
    assert.match(redactUrl(`https://mirror.example/${TOKEN}`), /^https:\/\/mirror\.example\/…#h=[0-9a-f]{8}$/);
    assert.equal(redactUrl("https://a.example/x?k=1"), redactUrl("https://a.example/x?k=1"));
    assert.notEqual(redactUrl("https://a.example/x?k=1"), redactUrl("https://a.example/x?k=2"));
    assert.match(redactUrl("not a url"), /^\[url\]#h=/);
  });

  it("redactUrls works inside sentences and keeps trailing punctuation", () => {
    const s = redactUrls(`download failed: https://m.example/a.tgz?token=${TOKEN}. Retry (file:///Users/${USER}/feed.json) later`);
    assert.doesNotMatch(s, new RegExp(`${TOKEN}|${USER}`));
    assert.match(s, /download failed: https:\/\/m\.example\/…\/a\.tgz#h=[0-9a-f]{8}\. Retry \(file:\/\/\/…\/feed\.json#h=[0-9a-f]{8}\) later/);
  });

  it("the report sink redacts URLs in lines, notes and the --json document", () => {
    const so = sink();
    const se = sink();
    const report = createReport({ json: true, stdout: so, stderr: se });
    report.step("feed", "failed", `GET https://m.example/f.json?token=${TOKEN}`);
    report.note(`see https://m.example/x/${TOKEN}/y`);
    report.set("origin", { url: `https://m.example/p?token=${TOKEN}`, list: [`https://m.example/q?${TOKEN}`] });
    report.finish(EXIT.FAILED);
    assert.doesNotMatch(so.text + se.text, new RegExp(TOKEN));
    assert.equal(JSON.parse(so.text).steps[0].id, "feed");
  });

  it("userHash is short and stable, and publicLicence replaces a legacy name", () => {
    assert.match(userHash(USER), /^[0-9a-f]{8}$/);
    assert.equal(userHash(USER), userHash(USER));
    assert.notEqual(userHash(USER), userHash("someone-else"));
    const l = publicLicence({ useClass: "general", accepted: { by: USER, at: "2026-01-01T00:00:00.000Z", licence: "CC-BY-NC-4.0" } });
    assert.equal(l.accepted.by, undefined);
    assert.equal(l.accepted.byHash, userHash(USER));
    assert.equal(l.accepted.at, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(publicLicence({ useClass: "general" }), { useClass: "general" });
  });

  it("scrubText drops credential lines, redacts URLs and long tokens, and is bounded", () => {
    setVerbose(false, ["/home/marker-home"]);
    const text = [
      `[openclaw] Reason: GET https://m.example/a?token=${TOKEN} failed in /home/marker-home/.openclaw`,
      `Authorization: Bearer ${BEARER}`,
      `leaked ${"A1b2".repeat(12)}`,
      "word ".repeat(300),
    ].join("\n");
    const s = scrubText(text, { lines: 4 });
    assert.doesNotMatch(s, new RegExp(`${TOKEN}|${BEARER}|marker-home|A1b2A1b2`));
    assert.match(s, /\[openclaw\] Reason: GET https:\/\/m\.example\/…#h=[0-9a-f]{8} failed in ~\/\.openclaw/);
    assert.ok(s.length <= 600 && s.endsWith("…"), String(s.length));
    setVerbose(true);
    try {
      assert.match(scrubText(text, { lines: 1 }), new RegExp(BEARER), "--verbose shows the child's text");
    } finally {
      setVerbose(false);
    }
  });
});

describe("child-process wrappers never relay more than the excerpt", { timeout: 120_000 }, () => {
  const stderr = ["boom y y", `fetch https://m.example/p?token=${TOKEN} failed`, `password=${BEARER}`, `middle ${BOUND}`, "tail one", "tail two"].join("\n");

  it("failureSummary: exit-bearing callers get a bounded, redacted excerpt; --verbose gets every line", () => {
    setVerbose(false);
    const s = failureSummary({ stderr });
    assert.match(s, /^boom y y \| fetch https:\/\/m\.example\/…#h=[0-9a-f]{8} failed$/);
    assert.doesNotMatch(s, new RegExp(`${TOKEN}|${BEARER}|${BOUND}`));
    setVerbose(true);
    try {
      const v = failureSummary({ stderr });
      assert.match(v, new RegExp(BOUND));
      assert.match(v, new RegExp(BEARER));
    } finally {
      setVerbose(false);
    }
  });

  it("plur1bus and hermes wrappers keep the exit code and scrub the text", async () => {
    setVerbose(false);
    const run = async () => ({ code: 7, stdout: "", stderr: `${stderr}\n`, timedOut: false });
    const px = createPlur1busCli({ bin: "plur1bus", home: "/nonexistent-home", env: {}, run });
    const r = await px.configGet("embedding.useClass");
    assert.match(r.detail, /^exit 7: /);
    assert.doesNotMatch(r.detail, new RegExp(`${TOKEN}|${BEARER}|${BOUND}`));

    const hx = createHermesCli({ bin: "hermes", env: {}, run });
    await assert.rejects(hx.configSet("memory.provider", "plur1bus"), (err) => {
      assert.equal(err.exitCode, 7);
      assert.match(err.message, /failed \(exit 7\)/);
      assert.doesNotMatch(err.message, new RegExp(`${TOKEN}|${BEARER}|${BOUND}`));
      return true;
    });

    const doc = JSON.stringify({ schema: "plur1bus.hermes-selftest/1", ok: false, checks: [{ id: "recall", ok: false, detail: `no hit for https://m.example/r?token=${TOKEN}` }] });
    const st = await createHermesCli({ bin: "hermes", env: {}, run: async () => ({ code: 1, stdout: `${doc}\n`, stderr: "", timedOut: false }) }).selftest();
    assert.doesNotMatch(st.detail, new RegExp(TOKEN));
    assert.match(st.detail, /recall: no hit for https:\/\/m\.example\/…#h=/);
  });

  it("the openclaw wrapper's own messages carry the exit code and no raw child text", async () => {
    setVerbose(false);
    const cli = createOpenclawCli({ bin: "openclaw", env: {}, run: async () => ({ code: 3, stdout: "", stderr: `${stderr}\n`, timedOut: false }) });
    await assert.rejects(cli.configSet("plugins.slots.memory", "x"), (err) => {
      assert.match(err.message, /failed \(exit 3\)/);
      assert.doesNotMatch(err.message, new RegExp(`${TOKEN}|${BEARER}|${BOUND}`));
      return true;
    });
  });
});

describe("installer end to end: nothing marked leaves by default", { timeout: 120_000 }, () => {
  const FAIL_STDERR = [
    "[openclaw] Command failed",
    `[openclaw] Reason: GET https://mirror.example/pkg.tgz?token=${TOKEN} failed`,
    `Authorization: Bearer ${BEARER}`,
    `trailing line ${BOUND}`,
  ].join("\n") + "\n";

  it("an OpenClaw install failure shows the exit code and a redacted excerpt; --verbose shows more, URLs stay redacted", async () => {
    const sb = createInstallerSandbox({ scenario: { installExit: 1, installStderr: FAIL_STDERR } });
    const r = await runSandboxInstaller(sb, ["--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.match(r.out, /exit 1/);
    assert.match(r.out, /Command failed/);
    assert.doesNotMatch(r.out, new RegExp(`${TOKEN}|${BEARER}|${BOUND}`));

    const sb2 = createInstallerSandbox({ scenario: { installExit: 1, installStderr: FAIL_STDERR } });
    const v = await runSandboxInstaller(sb2, ["--json", "--verbose"]);
    assert.equal(v.code, EXIT.FAILED, v.out);
    assert.match(v.out, new RegExp(BOUND), "--verbose shows the full text");
    assert.doesNotMatch(v.out, new RegExp(TOKEN), "URLs stay redacted even with --verbose");

    const sb3 = createInstallerSandbox({ scenario: { installExit: 1, installStderr: FAIL_STDERR } });
    const d = await runSandboxInstaller(sb3, ["--debug"]);
    assert.match(d.out, new RegExp(BOUND), "--debug is an alias of --verbose");
    // the flag does not leak into the next run
    const sb4 = createInstallerSandbox({ scenario: { installExit: 1, installStderr: FAIL_STDERR } });
    const again = await runSandboxInstaller(sb4, []);
    assert.doesNotMatch(again.out, new RegExp(BOUND));
  });

  it("the licence acceptance names a hash, not the OS user, in output, --json and the state file", async () => {
    const sb = createInstallerSandbox({ extraEnv: { USER } });
    const r = await runSandboxInstaller(sb, ["--accept-nc-licence", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.doesNotMatch(r.out, new RegExp(USER));
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.licence.accepted.byHash, userHash(USER));
    assert.match(r.stderr, /accepted by the current OS user at /);
    for (const f of [...files(sb.stateDir), ...files(sb.home)]) assert.doesNotMatch(f.text, new RegExp(USER), f.path);
    const state = files(sb.stateDir).find((f) => f.path.endsWith(".plur1bus-installer.json"));
    assert.ok(state, "the state file exists");
    assert.equal(JSON.parse(state.text).licence.byHash, userHash(USER));
  });

  const feedEnv = { PLUR1BUS_PLUGIN_INSTALLER_TEST: "1", PATH: "/usr/bin:/bin" };
  const opts = (fetchImpl, env, so, se) => ({ env, fetchImpl, stdout: so, stderr: se, isTTY: false, platform: process.platform, arch: process.arch });

  it("a --feed URL with a token is never echoed, and a note says it is visible in ps", async () => {
    const url = `https://mirror.example/plugin/stable.json?token=${TOKEN}`;
    const seen = [];
    const so = sink();
    const se = sink();
    const code = await runInstaller(["--feed", url, "--json", "--dry-run"], opts(async (u) => { seen.push(u); return { ok: false, status: 403 }; }, feedEnv, so, se));
    assert.equal(code, EXIT.FAILED);
    assert.equal(seen[0], url, "the real URL is still what is fetched");
    assert.doesNotMatch(so.text + se.text, new RegExp(TOKEN));
    assert.match(se.text, /--feed URL carries a query or credentials and is visible in the process list; pass it in PLUR1BUS_PLUGIN_FEED/);
    assert.match(se.text, /download failed: https:\/\/mirror\.example\/…\/stable\.json#h=[0-9a-f]{8}: HTTP 403/);
  });

  it("PLUR1BUS_PLUGIN_FEED is honoured without argv, and an http:// feed URL is not echoed either", async () => {
    const seen = [];
    const so = sink();
    const se = sink();
    const env = { ...feedEnv, PLUR1BUS_PLUGIN_FEED: `https://mirror.example/feed/stable.json?token=${TOKEN}` };
    const code = await runInstaller(["--json", "--dry-run"], opts(async (u) => { seen.push(u); return { ok: false, status: 500 }; }, env, so, se));
    assert.equal(code, EXIT.FAILED);
    assert.equal(seen[0], env.PLUR1BUS_PLUGIN_FEED);
    assert.doesNotMatch(so.text + se.text, new RegExp(TOKEN));

    const so2 = sink();
    const se2 = sink();
    await runInstaller(["--feed", `http://mirror.example/f.json?token=${TOKEN}`, "--json"], opts(async () => ({ ok: true }), feedEnv, so2, se2));
    assert.doesNotMatch(so2.text + se2.text, new RegExp(TOKEN));
    assert.match(se2.text, /feed URL must be https:\/\//);
  });

  it("--verbose and --debug are documented", () => {
    assert.match(USAGE, /--verbose, --debug/);
    assert.match(USAGE, /PLUR1BUS_PLUGIN_FEED/);
  });
});
