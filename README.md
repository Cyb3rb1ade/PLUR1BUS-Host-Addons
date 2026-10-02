# PLUR1BUS Host Add-ons

Installers, bootstraps, signed feed and release tooling that put PLUR1BUS memory onto a host:

- **OpenClaw**: installs the memory plugin
  [`@cyb3rb1ade/plur1bus-memory`](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory) through OpenClaw's own
  `plugins install`, verifies it with `openclaw plur1bus selftest` and rolls back on failure.
- **Hermes** (`--host hermes`): installs the PLUR1BUS memory provider into a Hermes agent plus a local PLUR1BUS sidecar.

This repository has its own version line (`0.1.0`, see `package.json` and `CHANGELOG.md`). It is private and never published to npm.
The versions the installer *installs* are plugin versions (and harness sidecar versions); they come from the signed feed
(`plur1bus.plugin-feed/1`), not from this repository's version.

## Install (what the add-ons ship)

Linux and macOS:

```bash
curl -fsSL https://plur1bus.app/install-plugin.sh | sh
```

Windows PowerShell (5.1 or 7):

```powershell
$s = (Invoke-WebRequest -UseBasicParsing https://plur1bus.app/install-plugin.ps1).Content; if ($s -is [byte[]]) { $s = [Text.Encoding]::UTF8.GetString($s) }; & ([scriptblock]::Create($s.TrimStart([char]0xFEFF)))
```

Hermes host mode (installs the PLUR1BUS memory provider into a Hermes agent, with a local sidecar):

```bash
curl -fsSL https://plur1bus.app/install-plugin.sh | sh -s -- --host hermes
```

On Windows append `-Host hermes` to the PowerShell one-liner. Every flag, exit code and the feed are in
[docs/distribution.md](docs/distribution.md).

## Relation to the other repositories

| Repository | Role |
|---|---|
| [`openclaw-plur1bus-memory`](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory) | The plugin (engine, OpenClaw adapter), its own release line, npm and ClawHub. Provides `openclaw plur1bus selftest`, the store snapshot format and the local-model profiles this repo's installer depends on. |
| PLUR1BUS harness | The Hermes provider (`hosts/hermes`) and the sidecar binary the Hermes legs install. Its `hermes-sidecar.lock.json` seed is copied to `scripts/dist/hermes-sidecar.lock.json` here at release time. |
| **this repository** | Installer bundle, `install-plugin.sh` / `install-plugin.ps1`, minisign verification, feed builder, install/upgrade/rollback matrix in CI. |

Two plugin modules are inlined into the installer bundle. They are **vendored** byte for byte in
`vendor/plur1bus-memory/` (provenance and SHA-256 in `vendor/plur1bus-memory/SOURCES.json`, checked by
`tests/vendor-sources.test.js`). Refresh them only from a plugin commit and update `SOURCES.json` in the same change.
The plugin commit that CI installs and packs is pinned in `plugin-pin.json`.

## Layout

```
scripts/dist/            build-installer.mjs, render-bootstraps.mjs, build-plugin-feed.mjs, minisign.mjs,
                         install-plugin.{sh,ps1}.in, installer/ (OpenClaw), installer/hermes/ (Hermes),
                         hermes-sidecar.lock.json, node-pins.json, plugin-feed.schema.json
vendor/plur1bus-memory/  vendored plugin modules + SOURCES.json
tests/                   dist-*.test.js, vendor-sources.test.js, helpers/, fixtures/
docs/                    distribution.md (user and operator reference), distribution/, release-notes/, release-checklist.md
.github/workflows/       ci.yml, plugin-dist.yml (install matrix), addons-release.yml
plugin-pin.json          the plugin repo + commit the install matrix packs
```

## Test

Node `>=24.16.0 <25 || >=26.1.0` (CI uses 24.21.0), Python >= 3.11 for the lock-interop test.

```bash
npm ci
npm test            # node --test over tests/
npm run lint        # node --check over scripts/ and tests/
npm run build:installer
npm run build:bootstraps
```

The Windows PowerShell 5.1 bootstrap tests and the shellcheck test skip where the tool is missing; CI sets
`PLUR1BUS_REQUIRE_LOCK_INTEROP=1` and `PLUR1BUS_REQUIRE_PS51=1` so they cannot skip silently there.
See `AGENTS.md` for the test seams, and `docs/distribution.md` for the installer reference.
