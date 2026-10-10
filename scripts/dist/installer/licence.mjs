/**
 * scripts/dist/installer/licence.mjs — the NC embedding licence gate (ADR-006, spec A.9).
 *
 * Interactive: the use-class question ("personal, non-commercial?"); yes leads
 * to an explicit CC BY-NC 4.0 confirmation for Jina v5 Text Nano, anything else
 * gives E5-small (MIT). Non-interactive: E5-small unless `--accept-nc-licence`
 * or PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1 (C11). Never a silent acceptance:
 * an acceptance always carries who (a short hash of the OS user name, never the name — audit K6 M-2), when, model, revision and licence.
 *
 * `useClass` (ruling F2, HM2-R18) is the harness setup's `--use-class`: `commercial` when the
 * personal-use question is answered no, else `general` (non-interactive, declined or accepted NC
 * licence). The Hermes installer passes its own licence question (`ncQuestion`) because the harness
 * sidecar, not this plugin, chooses the model.
 */

import { userInfo } from "node:os";
import { userHash } from "./redact.mjs";
import { E5_EMBEDDING_PROFILE, JINA_V5_NANO_EMBEDDING_PROFILE } from "../../../vendor/plur1bus-memory/lib/providers/local-model-artifacts.js";

export const EMBEDDINGGEMMA2_PROFILE_ID = "embeddinggemma-2-768";
export const EMBEDDINGGEMMA2_MODEL = "google/embeddinggemma-2";
export const EMBEDDINGGEMMA2_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
export const EMBEDDINGGEMMA2_LICENCE = "Apache-2.0";

export const E5_PROFILE_ID = "e5-multilingual-384";
export const JINA_V5_PROFILE_ID = "jina-v5-nano-768";
export const NC_LICENCE = "CC-BY-NC-4.0";

/** Model per preparation profile id (the embedding.model value written when none is configured). */
export const PROFILE_MODELS = Object.freeze({
  [EMBEDDINGGEMMA2_PROFILE_ID]: { model: EMBEDDINGGEMMA2_MODEL, revision: EMBEDDINGGEMMA2_REVISION, licence: EMBEDDINGGEMMA2_LICENCE },
  [E5_PROFILE_ID]: { model: E5_EMBEDDING_PROFILE.model, revision: E5_EMBEDDING_PROFILE.revision, licence: "MIT" },
  [JINA_V5_PROFILE_ID]: { model: JINA_V5_NANO_EMBEDDING_PROFILE.model, revision: JINA_V5_NANO_EMBEDDING_PROFILE.revision, licence: JINA_V5_NANO_EMBEDDING_PROFILE.license },
});

const yes = (a) => /^\s*(y|yes|j|ja)\s*$/i.test(String(a ?? ""));
const isGemma = (a) => /^\s*(1|gemma2|embeddinggemma-2|embeddinggemma-2-768|google\/embeddinggemma-2)\s*$/i.test(String(a ?? ""));
const isE5 = (a) => /^\s*(2|e5|e5-multilingual-384|intfloat\/multilingual-e5-small)\s*$/i.test(String(a ?? ""));
const isJina = (a) => /^\s*(3|jina|jina-v5|jina-v5-nano-768|jinaai\/jina-embeddings-v5-text-nano-retrieval)\s*$/i.test(String(a ?? ""));

function osUser(env) {
  const fromEnv = env.USER || env.USERNAME || env.LOGNAME;
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

function accept(env, now) {
  const p = PROFILE_MODELS[JINA_V5_PROFILE_ID];
  return {
    profile: JINA_V5_PROFILE_ID,
    acceptNonCommercialLicense: true,
    useClass: "general",
    accepted: { byHash: userHash(osUser(env)), at: new Date(now()).toISOString(), model: p.model, revision: p.revision, licence: NC_LICENCE },
  };
}

const E5 = (useClass = "general") => ({ profile: E5_PROFILE_ID, acceptNonCommercialLicense: false, useClass });
const EmbeddingGemma2 = (useClass = "general") => ({ profile: EMBEDDINGGEMMA2_PROFILE_ID, acceptNonCommercialLicense: false, useClass });

/**
 * @param {{ interactive: boolean, acceptNc: boolean, env: Record<string,string|undefined>, prompt: ((q: string) => Promise<string>) | null, now?: () => number, ncQuestion?: string, model?: string }} a
 * @returns {Promise<{ profile: string, acceptNonCommercialLicense: boolean, useClass: "general"|"commercial", accepted?: { byHash: string, at: string, model: string, revision: string, licence: "CC-BY-NC-4.0" } }>}
 */
export async function resolveLicence({ interactive, acceptNc, env, prompt, now = Date.now, ncQuestion, model }) {
  const requested = String(model || env?.PLUR1BUS_EMBEDDING_MODEL || "").trim().toLowerCase();
  if (requested) {
    if (isGemma(requested)) return EmbeddingGemma2();
    if (isE5(requested)) return E5();
    if (isJina(requested)) {
      if (acceptNc || env?.PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE === "1") return accept(env, now);
      if (!interactive || typeof prompt !== "function") return E5();
      const p = PROFILE_MODELS[JINA_V5_PROFILE_ID];
      const ok = await prompt(
        ncQuestion ?? `The model ${p.model} (revision ${p.revision.slice(0, 12)}) is licensed ${NC_LICENCE} (non-commercial use only). Accept this licence? [y/N] `,
      );
      return yes(ok) ? accept(env, now) : E5();
    }
  }

  if (acceptNc || env?.PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE === "1") return accept(env, now);
  if (!interactive || typeof prompt !== "function") return E5();

  if (ncQuestion) {
    const personal = await prompt("Is this installation for personal, non-commercial use? [y/N] ");
    if (!yes(personal)) return E5("commercial");
    const ok = await prompt(ncQuestion);
    return yes(ok) ? accept(env, now) : E5();
  }

  const choice = await prompt(
    "Choose local embedding model:\n" +
    "  [1] EmbeddingGemma 2 (google/embeddinggemma-2, 768d, Apache-2.0) [recommended]\n" +
    "  [2] Multilingual E5 Small (intfloat/multilingual-e5-small, 384d, MIT)\n" +
    "  [3] Jina v5 Text Nano (jinaai/jina-embeddings-v5-text-nano-retrieval, 768d, CC BY-NC 4.0)\n" +
    "Is this installation for personal, non-commercial use, or choose model [1/2/3/y/N] (default 1): "
  );

  if (isGemma(choice)) return EmbeddingGemma2();
  if (isE5(choice)) return E5();
  if (isJina(choice)) {
    const p = PROFILE_MODELS[JINA_V5_PROFILE_ID];
    const ok = await prompt(
      `The model ${p.model} (revision ${p.revision.slice(0, 12)}) is licensed ${NC_LICENCE} (non-commercial use only). Accept this licence? [y/N] `
    );
    return yes(ok) ? accept(env, now) : EmbeddingGemma2();
  }
  if (!yes(choice)) return E5("commercial");

  const p = PROFILE_MODELS[JINA_V5_PROFILE_ID];
  const ok = await prompt(
    `The recommended model ${p.model} (revision ${p.revision.slice(0, 12)}) is licensed ${NC_LICENCE} (non-commercial use only). Accept this licence? [y/N] `,
  );
  return yes(ok) ? accept(env, now) : E5();
}
