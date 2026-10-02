// tests/helpers/plugin-checkout.js — a checkout of the PLUGIN (Cyb3rb1ade/openclaw-plur1bus-memory) for the few tests that
// drive its real MemoryDB (seed-store, the local dry run of the installer leg). The plugin is not part of this repository:
// PLUR1BUS_PLUGIN_DIR names a checkout of the commit in plugin-pin.json whose node_modules hold @lancedb/lancedb
// (`npm ci --omit=dev --omit=optional --ignore-scripts` inside it is enough). Without it those tests skip with a reason;
// CI sets PLUR1BUS_REQUIRE_PLUGIN_DIR=1 so a missing checkout fails there instead.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/** @returns {{ dir: string, skip: false } | { dir: null, skip: string }} */
export function pluginCheckout(env = process.env) {
  const raw = env.PLUR1BUS_PLUGIN_DIR;
  let reason = "";
  if (!raw) reason = "PLUR1BUS_PLUGIN_DIR is not set (a plugin checkout at the commit in plugin-pin.json, with @lancedb/lancedb installed)";
  else {
    const dir = resolve(raw);
    if (!existsSync(join(dir, "engine", "store", "memory-db.js"))) reason = `${dir} has no engine/store/memory-db.js (not a plugin checkout)`;
    else {
      try {
        createRequire(join(dir, "package.json")).resolve("@lancedb/lancedb");
        return { dir, skip: false };
      } catch {
        reason = `@lancedb/lancedb does not resolve from ${dir} (run npm ci --omit=dev --omit=optional --ignore-scripts there)`;
      }
    }
  }
  if (env.PLUR1BUS_REQUIRE_PLUGIN_DIR === "1") throw new Error(`PLUR1BUS_REQUIRE_PLUGIN_DIR=1 but ${reason}`);
  return { dir: null, skip: reason };
}
