/**
 * scripts/dist/installer/redact.mjs — what the installer is allowed to print or record about URLs, the OS user
 * and the output of third-party child processes (privacy audit K6 M-1, M-2, M-4).
 *
 *  - `redactUrl` / `redactUrls`: a URL is shown as `scheme://host/…/<file>#h=<8 hex>`. Userinfo, query, fragment
 *    and every path segment but a plain file name with a known extension are dropped; the hash (SHA-256 over the
 *    full URL) lets two lines be correlated without revealing anything a token could sit in. Applied by the report
 *    sink (report.mjs) to every human line and every string of the `--json` document.
 *  - `userHash`: the licence acceptance record carries a short hash of the OS user name, never the name.
 *  - `scrubText` / `scrubLines`: a bounded, redacted excerpt of what `openclaw`, `hermes` or `plur1bus` printed.
 *    Lines that look like they carry a credential are dropped, URLs are redacted, the user's home directory is
 *    shown as `~`, long token-like strings are masked, and the result is capped. With `--verbose` (alias
 *    `--debug`) the excerpt is the child's text as printed (ANSI stripped, still capped at VERBOSE_MAX).
 *
 * The verbose switch is module state because the child-process wrappers are created far from the argument parser;
 * `main()` sets it on every run, so in-process callers (the tests) never inherit a previous run's value.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";

export const EXCERPT_MAX = 600;
export const VERBOSE_MAX = 4000;

let verbose = false;
let extraHomes = [];
/** Set per run by main(): `homes` are the HOME/USERPROFILE of the environment the installer was given. */
export const setVerbose = (on, homes = []) => {
  verbose = Boolean(on);
  extraHomes = homes.filter((h) => typeof h === "string");
};
export const isVerbose = () => verbose;

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

// ── URLs ────────────────────────────────────────────────────────────────────
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/(?=[\w[%/-])[^\s"'`<>)\]|]+/gi;
const SAFE_FILE_RE = /^[A-Za-z0-9._-]{1,64}\.(?:json|minisig|tgz|tar\.gz|tar\.xz|mjs|sh|ps1|zip)$/;

/** @param {string} url */
export function redactUrl(url) {
  const raw = String(url);
  const h = sha256hex(raw).slice(0, 8);
  let u;
  try {
    u = new URL(raw);
  } catch {
    return `[url]#h=${h}`;
  }
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  const file = SAFE_FILE_RE.test(last) ? `/…/${last}` : "/…";
  return `${u.protocol}//${u.hostname}${file}#h=${h}`;
}

/** Redact every URL inside free text. Trailing sentence punctuation stays outside the URL. */
export function redactUrls(text) {
  return String(text).replace(URL_RE, (m) => {
    const trail = /[.,;:!?]+$/.exec(m)?.[0] ?? "";
    const url = trail ? m.slice(0, -trail.length) : m;
    return (isKnownPlainUrl(url) ? url : redactUrl(url)) + trail;
  });
}

/** Hosts of the installer's own help links and default feed; shown as written when nothing in the URL can hold a secret. */
const KNOWN_HOSTS = new Set(["docs.openclaw.ai", "hermes-agent.nousresearch.com", "updates.plur1bus.app"]);
function isKnownPlainUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && KNOWN_HOSTS.has(u.hostname) && !u.username && !u.password && !u.search && !url.includes("#");
  } catch {
    return false;
  }
}

/** Deep copy of a JSON-like value with every string passed through `redactUrls`. */
export function redactDeep(value) {
  if (typeof value === "string") return redactUrls(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

/** True for a URL that carries userinfo or a query: something a token can hide in. */
export function urlCarriesSecretShape(url) {
  try {
    const u = new URL(String(url));
    return Boolean(u.username || u.password || u.search);
  } catch {
    return false;
  }
}

// ── OS user ─────────────────────────────────────────────────────────────────
/** Short, stable identifier of the accepting OS user (ADR-006 "who", K6 M-2); the name itself is never kept. */
export const userHash = (user) => sha256hex(`plur1bus-licence-acceptance\0${String(user)}`).slice(0, 8);

/** A licence record safe to persist: a legacy `by` (user name), flat or under `accepted`, becomes `byHash`. */
export function publicLicence(licence) {
  const strip = (a) => {
    if (!a || typeof a !== "object" || !("by" in a)) return a;
    const { by, ...rest } = a;
    return { byHash: rest.byHash ?? userHash(by), ...rest };
  };
  if (!licence || typeof licence !== "object") return licence;
  // OpenClaw's state file keeps the acceptance itself under `licence` ({ by, at, … }); Hermes nests it ({ useClass, accepted })
  const flat = strip(licence);
  return flat.accepted ? { ...flat, accepted: strip(flat.accepted) } : flat;
}

// ── child-process text ──────────────────────────────────────────────────────
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const SECRET_LINE_RE = /(?:api[_-]?key|access[_-]?key|secret|passw(?:or)?d|credential|authorization|bearer\s|\btoken\b|x-amz-signature)\s*[:=]|\bbearer\s+\S{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const TOKENISH_RE = /\b(?:sk|pk|ghp|gho|ghu|ghs|npm|xox[a-z])[-_][A-Za-z0-9_-]{16,}\b|\b[A-Za-z0-9_-]{40,}\b/g;

function safeHome() {
  try {
    return homedir();
  } catch {
    return "";
  }
}

function homePrefixes() {
  const out = new Set();
  for (const p of [...extraHomes, process.env.HOME, process.env.USERPROFILE, safeHome()]) if (p && p.length > 3 && p !== "/") out.add(p.replace(/[\\/]+$/, ""));
  return [...out].sort((a, b) => b.length - a.length);
}

const stripAnsi = (s) => String(s ?? "").replace(ANSI_RE, "");

/** One line, redacted: URLs, home directory, token-like strings. */
export function scrubLine(line) {
  let s = redactUrls(line);
  for (const home of homePrefixes()) s = s.split(home).join("~");
  return s.replace(TOKENISH_RE, "[redacted]");
}

export const isSecretLine = (line) => SECRET_LINE_RE.test(line);

const cap = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Join already-selected lines of child output into one report excerpt. Default: credential-looking lines dropped,
 * lines scrubbed, total capped at EXCERPT_MAX. Verbose: the lines as printed, capped at VERBOSE_MAX.
 * @param {string[]} lines
 */
export function scrubLines(lines, { max = EXCERPT_MAX } = {}) {
  const clean = lines.map((l) => stripAnsi(l).trim()).filter(Boolean);
  if (verbose) return cap(clean.join(" | "), VERBOSE_MAX);
  return cap(clean.map(scrubLine).filter((l) => !isSecretLine(l)).join(" | "), max);
}

/** Free text (one or more lines) of a child, as a bounded excerpt. */
export function scrubText(text, { lines = 3, max = EXCERPT_MAX } = {}) {
  const all = stripAnsi(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return scrubLines(verbose ? all : all.slice(0, lines), { max });
}
