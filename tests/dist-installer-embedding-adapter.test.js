// tests/dist-installer-embedding-adapter.test.js — OpenClaw embedding adapter ID validation,
// EmbeddingGemma 2 support, compatibility checks, installer selection, and existing config preservation.
// Local only, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_OPENCLAW_EMBEDDING_ADAPTERS,
  MIN_PLUGIN_VERSION_EMBEDDINGGEMMA2,
  checkEmbeddingAdapterCompat,
  checkCompat,
} from "../scripts/dist/installer/compat.mjs";
import {
  EMBEDDINGGEMMA2_PROFILE_ID,
  EMBEDDINGGEMMA2_MODEL,
  EMBEDDINGGEMMA2_REVISION,
  EMBEDDINGGEMMA2_LICENCE,
  E5_PROFILE_ID,
  JINA_V5_PROFILE_ID,
  PROFILE_MODELS,
  resolveLicence,
} from "../scripts/dist/installer/licence.mjs";
import { PLUGIN_ID } from "../scripts/dist/installer/openclaw-cli.mjs";
import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readState } from "../scripts/dist/installer/state.mjs";
import { createInstallerSandbox, runSandboxInstaller } from "./helpers/installer-sandbox.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = `plugins.entries.${PLUGIN_ID}.config`;

describe("OpenClaw embedding adapter validation and compatibility", () => {
  it("ALLOWED_OPENCLAW_EMBEDDING_ADAPTERS includes plur1bus-embeddinggemma-2 and all known adapters", () => {
    assert.ok(Array.isArray(ALLOWED_OPENCLAW_EMBEDDING_ADAPTERS));
    assert.ok(Object.isFrozen(ALLOWED_OPENCLAW_EMBEDDING_ADAPTERS));
    assert.deepEqual([...ALLOWED_OPENCLAW_EMBEDDING_ADAPTERS].sort(), [
      "plur1bus-e5-small",
      "plur1bus-embeddinggemma-2",
      "plur1bus-openai",
      "plur1bus-openai-compatible",
    ]);
  });

  it("MIN_PLUGIN_VERSION_EMBEDDINGGEMMA2 placeholder is defined and formatted as semver", () => {
    assert.match(MIN_PLUGIN_VERSION_EMBEDDINGGEMMA2, /^\d+\.\d+\.\d+$/);
  });

  it("checkEmbeddingAdapterCompat accepts valid adapter IDs", () => {
    for (const id of ["plur1bus-openai", "plur1bus-openai-compatible", "plur1bus-e5-small"]) {
      const res = checkEmbeddingAdapterCompat(id, "7.16.11");
      assert.equal(res.ok, true, `expected ${id} to be valid`);
      assert.equal(res.fatal, false);
      assert.equal(res.detail, id);
    }
  });

  it("checkEmbeddingAdapterCompat accepts plur1bus-embeddinggemma-2 for supported versions", () => {
    const res = checkEmbeddingAdapterCompat("plur1bus-embeddinggemma-2", MIN_PLUGIN_VERSION_EMBEDDINGGEMMA2);
    assert.equal(res.ok, true);
    assert.equal(res.fatal, false);
    assert.equal(res.warn, undefined);
  });

  it("checkEmbeddingAdapterCompat reports 'requires plugin with EmbeddingGemma 2 support' on older plugin version without hard breaking", () => {
    const res = checkEmbeddingAdapterCompat("plur1bus-embeddinggemma-2", "7.16.11");
    assert.equal(res.ok, true, "does not break hard");
    assert.equal(res.fatal, false, "must not be fatal");
    assert.equal(res.warn, true, "reports as warning");
    assert.equal(res.id, "plugin-embeddinggemma2-unsupported");
    assert.match(res.detail, /requires plugin with EmbeddingGemma 2 support/);
  });

  it("checkEmbeddingAdapterCompat rejects typo and unknown adapter IDs", () => {
    for (const typo of [
      "plur1bus-embeddinggemma",
      "plur1bus-embedding-gemma-2",
      "plur1bus-gemma2",
      "plur1bus-e5",
      "plur1bus-e5-smalll",
      "openai",
      "unknown-adapter",
      "",
    ]) {
      const res = checkEmbeddingAdapterCompat(typo, "7.19.0");
      assert.equal(res.ok, false, `expected typo "${typo}" to be rejected`);
      assert.equal(res.fatal, true);
      assert.equal(res.id, "unknown-embedding-adapter");
      assert.match(res.detail, /unknown embedding adapter/);
    }
  });

  it("checkCompat validates embeddingAdapter and reports fatal on unknown typo", () => {
    const findings = checkCompat({
      openclawVersion: "2026.8.2",
      nodeVersion: "24.16.0",
      target: { target: "darwin-arm64", supported: true, detail: "darwin-arm64" },
      release: { version: "7.19.0", compat: { minGatewayVersion: "2026.8.1" }, node: ">=24.16.0 <25 || >=26.1.0" },
      freeBytes: 2 * 1024 * 1024 * 1024,
      readonlyConfig: null,
      configValid: true,
      baseDbPath: "/home/user/.openclaw/memory/lancedb-namespaced",
      embeddingAdapter: "plur1bus-embeddinggemma-typo",
    });
    assert.ok(findings.some((f) => f.id === "unknown-embedding-adapter" && f.fatal));
  });

  it("checkCompat with plur1bus-embeddinggemma-2 and older plugin reports non-fatal warning", () => {
    const findings = checkCompat({
      openclawVersion: "2026.8.2",
      nodeVersion: "24.16.0",
      target: { target: "darwin-arm64", supported: true, detail: "darwin-arm64" },
      release: { version: "7.16.11", compat: { minGatewayVersion: "2026.8.1" }, node: ">=24.16.0 <25 || >=26.1.0" },
      freeBytes: 2 * 1024 * 1024 * 1024,
      readonlyConfig: null,
      configValid: true,
      baseDbPath: "/home/user/.openclaw/memory/lancedb-namespaced",
      embeddingAdapter: "plur1bus-embeddinggemma-2",
    });
    const warning = findings.find((f) => f.id === "plugin-embeddinggemma2-unsupported");
    assert.ok(warning, "must find plugin-embeddinggemma2-unsupported");
    assert.equal(warning.fatal, false);
    assert.equal(warning.warn, true);
    assert.match(warning.detail, /requires plugin with EmbeddingGemma 2 support/);
  });
});

describe("EmbeddingGemma 2 profile definition and installer selection", () => {
  it("PROFILE_MODELS defines embeddinggemma-2-768 with Apache-2.0 license", () => {
    assert.equal(EMBEDDINGGEMMA2_PROFILE_ID, "embeddinggemma-2-768");
    assert.equal(EMBEDDINGGEMMA2_MODEL, "google/embeddinggemma-2");
    assert.equal(EMBEDDINGGEMMA2_REVISION, "daa72c51243991dfcaf9f9137d2c573d8f7790c0");
    assert.equal(EMBEDDINGGEMMA2_LICENCE, "Apache-2.0");

    const p = PROFILE_MODELS[EMBEDDINGGEMMA2_PROFILE_ID];
    assert.ok(p, "embeddinggemma-2-768 must be in PROFILE_MODELS");
    assert.equal(p.model, "google/embeddinggemma-2");
    assert.equal(p.revision, "daa72c51243991dfcaf9f9137d2c573d8f7790c0");
    assert.equal(p.licence, "Apache-2.0");
  });

  it("resolveLicence supports explicit selection of EmbeddingGemma 2 without NC prompt", async () => {
    for (const m of ["gemma2", "embeddinggemma-2", "embeddinggemma-2-768", "google/embeddinggemma-2"]) {
      const res = await resolveLicence({
        interactive: false,
        acceptNc: false,
        model: m,
        env: {},
        prompt: null,
      });
      assert.equal(res.profile, EMBEDDINGGEMMA2_PROFILE_ID);
      assert.equal(res.acceptNonCommercialLicense, false);
      assert.equal(res.useClass, "general");
      assert.equal(res.accepted, undefined, "Apache-2.0 requires no NC acceptance record");
    }
  });

  it("resolveLicence supports interactive recommendation of EmbeddingGemma 2", async () => {
    const asked = [];
    // User chooses recommendation (e.g. "1" or default "" or "gemma2")
    const res = await resolveLicence({
      interactive: true,
      acceptNc: false,
      env: {},
      prompt: async (q) => {
        asked.push(q);
        return "1";
      },
    });
    assert.equal(res.profile, EMBEDDINGGEMMA2_PROFILE_ID);
    assert.equal(res.acceptNonCommercialLicense, false);
    assert.equal(res.useClass, "general");
  });

  it("installer --model gemma2 sets EmbeddingGemma 2 profile and model", async () => {
    const sb = createInstallerSandbox();
    const r = await runSandboxInstaller(sb, ["--model", "gemma2", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const calls = sb.openclawCalls();
    assert.ok(
      calls.some((a) => a.join(" ") === `config set ${C}.modelPreparation.profile embeddinggemma-2-768`),
      "profile must be set to embeddinggemma-2-768",
    );
    assert.ok(
      calls.some((a) => a.join(" ") === `config set ${C}.modelPreparation.acceptNonCommercialLicense false`),
      "acceptNonCommercialLicense must be false",
    );
    assert.ok(
      calls.some((a) => a.join(" ") === `config set ${C}.embedding.provider local-transformers`),
      "provider must be local-transformers",
    );
    assert.ok(
      calls.some((a) => a.join(" ") === `config set ${C}.embedding.model google/embeddinggemma-2`),
      "model must be google/embeddinggemma-2",
    );
    const st = readState(sb.stateDir);
    assert.equal(st.licence, undefined, "no NC license record written for Apache-2.0");
  });

  it("installer with existing embedding config preserves it unchanged", async () => {
    const sb = createInstallerSandbox({
      scenario: {
        config: {
          [`${C}.embedding.provider`]: "local-transformers",
          [`${C}.embedding.model`]: "intfloat/multilingual-e5-small",
          [`${C}.modelPreparation.profile`]: "e5-multilingual-384",
        },
      },
    });
    const r = await runSandboxInstaller(sb, ["--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const setCalls = sb.openclawCalls().filter((a) => a[1] === "set").map((a) => a[2]);
    assert.ok(
      !setCalls.some((k) => k.includes("embedding") || k.includes("modelPreparation")),
      "must not modify existing embedding or modelPreparation config",
    );
  });
});

describe("Fixture contracts include plur1bus-embeddinggemma-2", () => {
  const fixtures = [
    "inspect-runtime-loaded.json",
    "inspect-installed.json",
    "inspect-installed-clawhub.json",
    "inspect-installed-2026.8.1-slot-unset.json",
    "inspect-legacy-untracked.json",
  ];

  for (const file of fixtures) {
    it(`${file} includes plur1bus-embeddinggemma-2 in embeddingProviderIds and contracts`, () => {
      const content = JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "openclaw-cli", file), "utf8"));
      const p = content.plugin || content;
      assert.ok(
        p.embeddingProviderIds.includes("plur1bus-embeddinggemma-2"),
        `embeddingProviderIds in ${file} must include plur1bus-embeddinggemma-2`,
      );
      if (p.contracts?.embeddingProviders) {
        assert.ok(
          p.contracts.embeddingProviders.includes("plur1bus-embeddinggemma-2"),
          `contracts.embeddingProviders in ${file} must include plur1bus-embeddinggemma-2`,
        );
      }
    });
  }
});
