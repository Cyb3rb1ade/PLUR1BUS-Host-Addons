# Changelog — PLUR1BUS Host Add-ons

Alle wichtigen Änderungen an diesem Projekt werden in dieser Datei dokumentiert.
Dieses Repository hat eine eigene Versionslinie (beginnend bei 0.1.0), unabhängig von den Plugin-Versionen, die der
Installer installiert. Die Einträge von 0.1.0 stammen aus dem Abschnitt `[7.19.0]` des Plugin-Changelogs
(HM1: Distribution für OpenClaw, HM2: Hermes-Hostmodus).

## [0.1.0] — unreleased

### Hinzugefügt

- **`--host hermes`** für den Installer und beide Bootstraps (`-Host hermes`
  in der `.ps1`): installiert den PLUR1BUS-Memory-Provider nach
  `$HERMES_HOME/plugins/plur1bus/` und einen lokalen PLUR1BUS-Sidecar
  (`plur1bus setup --profile host`), dessen Binary der signierte Feed
  (`hosts.hermes`) per URL und SHA-256 festlegt. Erkennung von Hermes, Version,
  Python und Home (Windows: `%LOCALAPPDATA%\hermes`), gesammelte
  Kompatibilitätsbefunde (Exit 3), Agent pro Hermes-Home, Bindungsregister mit
  einer mit dem Python-Provider geteilten Sperre, `memory.provider` erst nach
  dem Provider-Verzeichnis (bei 0.21.4 und unbekannten Versionen per
  Zeilen-Edit mit Backup), Verifikation über `hermes memory status` und
  `hermes plur1bus selftest`, Rollback in umgekehrter Reihenfolge und
  Wiederaufnahme unterbrochener Läufe.
- **Hermes-Update** mit Release-Notes, Now/Later/Skip, Speicher-Snapshot,
  byteweiser Sicherung von `manifest.json`/`config.json` und Binary-Rollback;
  **Deinstallation**, die `memory.provider` exakt wiederherstellt, und **Purge**,
  der verweigert, solange ein anderes Hermes-Home den Sidecar nutzt. Eine
  Installation über einen älteren gemeinsamen Host-Sidecar läuft wie dieses
  Update (Stopp, Sicherung, Snapshot, Binary, Setup) und wird ebenso
  zurückgerollt; ein Sidecar wird nur wiederverwendet, wenn auch
  `plur1bus --version` mindestens die Release-Version meldet.
- **Node-Kette der Bootstraps** für Hermes: PATH, Hermes' eigenes Node, das
  Node eines Sidecars, sonst ein festgelegtes, hash-geprüftes portables
  Node 24.21.0 (`scripts/dist/node-pins.json`; der Renderer verlangt
  `--node-pins`).
- **plugin-dist.yml**: Hermes-Beine auf drei Betriebssystemen (min/latest), ein
  WSL-Bein und ein Abgleich der Node-Pins mit nodejs.org. Ohne Harness-Release
  P4 baut `build-sidecar` die Binaries aus dem Pin.
- **Ein-Zeilen-Installer** `install-plugin.sh` (Linux, macOS) und
  `install-plugin.ps1` (Windows nativ, Beta; WSL2 über Delegation an das
  Linux-Skript). Die Bootstraps verifizieren den signierten Plugin-Feed
  (minisign) **vor** jeder URL und jedem Hash darin, prüfen den gebündelten
  Node-Installer per SHA-256 und starten ihn als Kindprozess. Fünf Ziele:
  `linux-x64`, `linux-arm64`, `darwin-arm64`, `win-x64`, `win-arm64`.
- **Node-Installer** (`plur1bus-plugin-installer.mjs`): Installation über
  `openclaw plugins install` (ClawHub mit ClawPack-Digest, sonst der über den
  Feed per SHA-256 verifizierte GitHub-Release-Tarball; `--source npm`,
  `--offline <tgz>`), Kompatibilitätsprüfung mit gesammelten Befunden (Exit 3),
  lizenzabhängige Modellwahl (`--accept-nc-licence`), Verifikation und
  automatischer Rollback. `--update` mit Release-Notes (de/en), Store-Snapshot
  und Rollback samt Wiederaufnahme unterbrochener Läufe, `--uninstall
  [--purge]`, `--adopt-legacy` für rsync-Deployments (mit Schutz vor
  `protect-plur1bus-deploy.sh`), `--dry-run`, `--json`. Exit-Codes 0–4.
  Details: `docs/distribution.md`.
- **Signierter Plugin-Feed** `plur1bus.plugin-feed/1`
  (`scripts/dist/build-plugin-feed.mjs`, offline vom Owner signiert).
- **`plugin-dist.yml`**: Installations- und Upgrade-Matrix auf den fünf Zielen
  mit echtem OpenClaw (min und latest).
- Eigenes Repository: das Plugin-Modul `store-snapshot.js` und das Profil-Modul
  `local-model-artifacts.js`, die das Installer-Bundle einbindet, liegen
  unverändert unter `vendor/plur1bus-memory/` (Herkunft und SHA-256 in
  `SOURCES.json`, geprüft von `tests/vendor-sources.test.js`).

### Geändert

- `plugin-dist.yml` baut den Hermes-Provider und die Sidecar-Binaries aus dem Harness-Commit
  in `harness-pin.json`, solange `HM2_SIDECAR_RELEASED` nicht `true` ist. Das TEST-ONLY-CI-Feed
  zeigt per `file://` und SHA-256 auf diese Artefakte. Der Produktions-Feed und der Installer
  bleiben unverändert. Die Hermes-Jobs sind damit blockierend.
- `upgrade-from-release` akzeptiert `cyb3rb1ade-plur1bus-memory-*.tgz` und
  `plur1bus-*.tgz` (grep-Fallback unter `pipefail`). Liegt das Release auf
  derselben Version wie der Pin, entfällt der Upgrade-Lauf. `plugin-pin.json`
  zeigt auf Plugin `3690fb3` (7.18.4 inkl. #207).
- `hermes-wsl` schreibt die Provider-`file://`-URL im TEST-ONLY-Feed als
  `/mnt/<laufwerk>/…`, weil Node in WSL aus `file:///D:/…` den Pfad `/D:/…` macht.
- OpenClaw `latest` in der Install-Matrix ist nur auf Linux vorübergehend
  `continue-on-error` (OpenClaw 2026.9.8, `src/plugins/plugin-source-capture-path.ts`,
  sharp/libvips). macOS und Windows `latest` bleiben blockierend.
- Der Feed erlaubt `hosts.hermes` (Schema).
- Solange `scripts/dist/hermes-sidecar.lock.json` ein Platzhalter ist, baut
  auch ein echter Lauf den Feed ohne neues Hermes-Release und warnt in Log und
  Job-Zusammenfassung; reine OpenClaw-Releases werden nie blockiert.
  `build-plugin-feed.mjs` übernimmt ein Hermes-Release, das schon mit denselben
  Hashes im vorigen Feed steht, unverändert und verweigert nur andere Hashes
  für dieselbe Version.
- Der Installer setzt `hooks.allowConversationAccess` bei Neuinstallation und
  Übernahme (ohne den Schalter arbeiten Capture und Recall nicht) und ändert
  ihn bei Updates nie.

### English

- One-line installers for OpenClaw (`install-plugin.sh`, `install-plugin.ps1`)
  with a signed feed verified before anything in it is trusted; install, update
  (snapshot, automatic rollback, resume), uninstall/purge and adoption of rsync
  deploys; Hermes host mode (`--host hermes`); the `plugin-dist.yml` five-target
  matrix. See `docs/distribution.md`.
