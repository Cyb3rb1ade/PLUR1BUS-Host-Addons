# AGENTS.md — PLUR1BUS Host Add-ons

Host add-on tooling for PLUR1BUS: the OpenClaw and Hermes installers, the `install-plugin.{sh,ps1}` bootstraps, the signed
plugin feed and the CI install matrix. The memory plugin itself lives in `Cyb3rb1ade/openclaw-plur1bus-memory` and has its own
AGENTS.md; do not copy plugin code here except through `vendor/plur1bus-memory/` (see README).

## Commit identity

Commit as `Cyb3rb1ade <84099452+Cyb3rb1ade@users.noreply.github.com>`, for example
`git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit`. Do not change git config.
No secrets in the repository, in commits or in CI logs.

## Tests

```bash
npm ci
npm test
```

- Plugin distribution (HM1/HM2, `docs/distribution.md`): `tests/dist-*.test.js` (bootstraps, feed, minisign, installer bundle
  and modes, gateway status, CI helpers; Hermes host mode: `dist-hermes-{install,update,uninstall,feed,untar}`,
  `dist-node-pins`) and `tests/vendor-sources.test.js`. `.github/workflows/plugin-dist.yml` installs the packed plugin
  into disposable OpenClaw instances on five targets, upgrades, forces a rollback and uninstalls; its `hermes` and
  `hermes-wsl` legs do the same against disposable Hermes instances (`build-sidecar` supplies the binaries until
  `vars.HM2_SIDECAR_RELEASED` is `true`), and `node-pins` compares `scripts/dist/node-pins.json` with nodejs.org. The full suite on Linux, macOS and
  Windows runs in `ci.yml`.
- The installer's test seams exist for tests only: `PLUR1BUS_PLUGIN_INSTALLER_TEST=1`
  with `PLUR1BUS_PLUGIN_FEED` `file://`, `PLUR1BUS_PLUGIN_PUBKEY`,
  `PLUR1BUS_PLUGIN_WSL_EXE`, `PLUR1BUS_PLUGIN_TEST_FREE_BYTES`,
  `PLUR1BUS_SELFTEST_FORCE_FAIL`; for `--host hermes` also
  `PLUR1BUS_PLUGIN_TEST_NO_SERVICE=1` (setup with `--no-service`),
  `PLUR1BUS_PLUGIN_TEST_KILL_AT=<point>` (kills the installer at a named step),
  `PLUR1BUS_PLUGIN_TEST_FAIL_AT=purge.rm` (fails the purge's home deletion),
  `PLUR1BUS_LOCK_TEST_PAUSE_DIR=<dir>` (the registry lock pauses once after
  judging a lock stale, for the deterministic double-break test) and,
  in the bootstraps, `PLUR1BUS_PLUGIN_TEST_NODE_BASE` (a `file://` directory
  instead of nodejs.org for the pinned Node). Installer tests never touch a real
  OpenClaw or Hermes: they use `openclaw`, `node` and `wsl.exe` shims through
  `tests/helpers/installer-sandbox.js`, and `hermes` and `plur1bus` shims through
  `tests/helpers/hermes-sandbox.js` (both on `tests/helpers/sandbox-common.js`,
  which throws if `PATH` resolves a non-shim). Real OpenClaw and Hermes run only
  in CI on disposable runners (`tests/helpers/assert-disposable.mjs`,
  `--host hermes` for Hermes).
- `tests/dist-hermes-lock-interop.test.js` runs Node and Python (>= 3.11)
  holders on one bindings-registry lock; it skips without Python unless
  `PLUR1BUS_REQUIRE_LOCK_INTEROP=1` (set in CI's `ci.yml`).
- `tests/dist-hermes-lock-fr-l1.test.js` checks FR-L1 option (ii): a displaced
  holder refuses the publishing rename (`docs/lock-fr-l1-analysis.md`). Manual
  helpers `tests/helpers/lock-fr-l1-loop.mjs` and `lock-interop-measure.mjs` are
  not part of `npm test`. `PLUR1BUS_LOCK_TEST_TIMES=1` adds timestamps to interop
  worker event lines (ignored by `checkEvents`).
- `tests/vendor-sources.test.js` fails when a file under `vendor/plur1bus-memory/` differs from the SHA-256 in
  `vendor/plur1bus-memory/SOURCES.json`. Never edit vendored files by hand; re-copy from the plugin commit and update
  `SOURCES.json`.
- Two tests drive the plugin's real MemoryDB (seed-store, the local dry run of the installer leg). They need a checkout of
  the plugin at the commit in `plugin-pin.json` with `@lancedb/lancedb` installed (`npm ci --omit=dev --omit=optional
  --ignore-scripts` inside it) named by `PLUR1BUS_PLUGIN_DIR`; without it they skip with a reason, and
  `PLUR1BUS_REQUIRE_PLUGIN_DIR=1` (set in `ci.yml`) turns the skip into a failure.
- Two tests depend on the machine: the `dist-ci-helpers` dry run needs 1.5 GiB free disk (the installer's own
  `insufficient-disk` check), and `dist-ci-helpers` / `dist-installer-update` load `@lancedb/lancedb` from this checkout's
  `node_modules`.
