#!/usr/bin/env node
// premises: re-check every premise in a premises.json ledger against its quoted source,
// and check that each premise's linked tests fail when the code that encodes it changes.
// Dependency-free: Node 22.17 or later, standard library only.
// Exit codes: 0 no findings, 1 findings, 2 usage or input error.

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  constants, cpSync, existsSync, globSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const VERDICTS = ['supported', 'contradicted', 'unsupported'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// A relative path with no ".." segment, so it stays inside the ledger's directory.
const INSIDE_PATH = /^(?![/\\]|[A-Za-z]:)(?!(?:.*[/\\])?\.\.(?:[/\\]|$)).+$/;
const FETCH_TIMEOUT_MS = 15000;
const MUTANT_MIN_TIMEOUT_MS = 10000;
const LEDGER_KEYS = ['$schema', 'task', 'testFiles', 'testCommand', 'premises'];
const PREMISE_KEYS = [
  'id', 'claim', 'source', 'quote', 'retrieved', 'verdict', 'tests', 'mutants', 'paraphrasedIn', 'snapshot', 'jsRendered', 'note',
];

const USAGE = `Usage: premises check [path]
       premises mutate [path]

path is a premises.json ledger, or a directory that holds one (default: ./premises.json).
Both commands print a JSON report.

check: re-reads every quote from its source and checks every test link.
  0  every quote was found and every test link is valid
  1  a quote is missing or changed, a listed test does not exist, or a test pins
     a premise whose verdict is not "supported"
  2  usage or input error (bad arguments, unreadable or invalid premises.json,
     a symbolic link in the path of an HTTP capture)

mutate: changes the code each premise's "mutants" point at, one value at a time, in a
temporary copy of the ledger's directory, and runs the ledger's testCommand for that
premise's linked tests. It runs commands from the ledger, so only use it on a trusted one.
  0  the linked tests failed for every mutant
  1  a mutant survived, or a "mutants" target is not found, not unique, or has no value
  2  usage or input error, including a missing testCommand, or linked tests that
     fail before any mutation`;

class InputError extends Error {}

// Collapse every run of whitespace to one space, so line wrapping and indentation
// never decide whether a quote matches. Nothing else is changed.
export function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
};

// Decode a numeric entity, but leave one that names no Unicode code point as text.
function fromCodePoint(entity, n) {
  return n <= 0x10ffff ? String.fromCodePoint(n) : entity;
}

const BLOCK_TAG = /<\/?(address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

// Reduce an HTML page to its visible text, so a quote copied from a browser matches.
// Block and line-break tags separate words; inline tags such as <code> or <a> do not.
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(BLOCK_TAG, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => fromCodePoint(m, parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => fromCodePoint(m, Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function fail(message) {
  throw new InputError(message);
}

function onlyKeys(obj, allowed, at) {
  const extra = Object.keys(obj).find((k) => !allowed.includes(k));
  if (extra !== undefined) fail(`${at} has unknown field "${extra}"`);
}

// Structural validation that mirrors schema/premises.schema.json.
export function validate(ledger) {
  if (typeof ledger !== 'object' || ledger === null || Array.isArray(ledger)) fail('ledger must be a JSON object');
  onlyKeys(ledger, LEDGER_KEYS, 'ledger');
  if (!Array.isArray(ledger.premises)) fail('"premises" must be an array');
  if (ledger.testFiles !== undefined) {
    if (!Array.isArray(ledger.testFiles) || !ledger.testFiles.every((g) => typeof g === 'string' && g)) {
      fail('"testFiles" must be an array of non-empty glob strings');
    }
  }
  if (ledger.testCommand !== undefined) {
    const cmd = ledger.testCommand;
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === 'string' && a)) {
      fail('"testCommand" must be a non-empty array of non-empty strings');
    }
  }
  const seen = new Set();
  ledger.premises.forEach((p, i) => {
    const at = `premises[${i}]`;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) fail(`${at} must be an object`);
    onlyKeys(p, PREMISE_KEYS, at);
    if (typeof p.id !== 'string' || !ID.test(p.id)) fail(`${at}.id must match ${ID}`);
    if (seen.has(p.id)) fail(`${at}.id "${p.id}" is a duplicate`);
    seen.add(p.id);
    if (typeof p.claim !== 'string' || !p.claim.trim()) fail(`${at}.claim must be a non-empty string`);
    if (!VERDICTS.includes(p.verdict)) fail(`${at}.verdict must be one of ${VERDICTS.join(', ')}`);
    const sourced = p.verdict !== 'unsupported' || p.source !== undefined || p.quote !== undefined;
    if (sourced) {
      if (typeof p.source !== 'string' || !p.source) fail(`${at}.source must be a non-empty string`);
      if (typeof p.quote !== 'string' || !normalize(p.quote)) fail(`${at}.quote must be a non-empty string`);
      if (typeof p.retrieved !== 'string' || !DATE.test(p.retrieved)) fail(`${at}.retrieved must be a YYYY-MM-DD date`);
    }
    if (!Array.isArray(p.tests) || !p.tests.every((t) => typeof t === 'string' && t.trim())) {
      fail(`${at}.tests must be an array of non-empty strings`);
    }
    if (p.mutants !== undefined) {
      if (p.verdict !== 'supported') fail(`${at}.mutants is only allowed on a supported premise`);
      if (!Array.isArray(p.mutants)) fail(`${at}.mutants must be an array`);
      p.mutants.forEach((m, j) => {
        const mat = `${at}.mutants[${j}]`;
        if (typeof m !== 'object' || m === null || Array.isArray(m)) fail(`${mat} must be an object`);
        if (typeof m.file !== 'string' || !INSIDE_PATH.test(m.file)) {
          fail(`${mat}.file must be a relative path inside the ledger's directory, without ".."`);
        }
        if (typeof m.find !== 'string' || !m.find.trim()) fail(`${mat}.find must be a non-empty string`);
        onlyKeys(m, ['file', 'find'], mat);
      });
    }
    if (p.paraphrasedIn !== undefined) {
      if (!Array.isArray(p.paraphrasedIn)) fail(`${at}.paraphrasedIn must be an array`);
      p.paraphrasedIn.forEach((s, j) => {
        if (typeof s?.source !== 'string' || !s.source) fail(`${at}.paraphrasedIn[${j}].source must be a non-empty string`);
        if (typeof s.quote !== 'string' || !normalize(s.quote)) fail(`${at}.paraphrasedIn[${j}].quote must be a non-empty string`);
        onlyKeys(s, ['source', 'quote'], `${at}.paraphrasedIn[${j}]`);
      });
    }
    if (p.snapshot !== undefined) {
      if (!/^https?:/.test(p.source ?? '')) fail(`${at}.snapshot is only allowed for http(s) sources`);
      if (typeof p.snapshot?.path !== 'string' || !p.snapshot.path) fail(`${at}.snapshot.path must be a non-empty string`);
      if (typeof p.snapshot.sha256 !== 'string' || !SHA256.test(p.snapshot.sha256)) fail(`${at}.snapshot.sha256 must be 64 lowercase hex digits`);
      onlyKeys(p.snapshot, ['path', 'sha256'], `${at}.snapshot`);
    }
    if (p.jsRendered !== undefined) {
      if (typeof p.jsRendered !== 'boolean') fail(`${at}.jsRendered must be a boolean`);
      if (p.snapshot === undefined) fail(`${at}.jsRendered requires a snapshot`);
    }
    if (p.note !== undefined && typeof p.note !== 'string') fail(`${at}.note must be a string`);
  });
  return ledger;
}

// Read one source and return its text. HTTP responses are also stored in the capture
// directory with the command that reproduces the fetch.
async function readSource(source, ctx) {
  if (/^https?:\/\//.test(source)) {
    if (!ctx.cache.has(source)) ctx.cache.set(source, fetchAndCapture(source, ctx));
    return ctx.cache.get(source);
  }
  if (source.startsWith('git:')) {
    const rest = source.slice(4);
    const colon = rest.indexOf(':');
    if (colon <= 0 || colon === rest.length - 1) throw new Error('git source must look like git:<ref>:<path>');
    const ref = rest.slice(0, colon);
    const path = rest.slice(colon + 1);
    const command = ['git', '-C', ctx.baseDir, 'show', '--end-of-options', `${ref}:${path}`];
    try {
      const body = execFileSync(command[0], command.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { text: body };
    } catch (err) {
      throw new Error(`git show ${ref}:${path} failed: ${normalize(String(err.stderr || err.message))}`, { cause: err });
    }
  }
  const file = isAbsolute(source) ? source : resolve(ctx.baseDir, source);
  return { text: readFileSync(file, 'utf8') };
}

// Git can carry a symlink in a cloned repository, so a ledger must not be able to
// redirect a capture write out of .premises/captures/.
function refuseSymlink(path, ctx) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fail(`refusing to write captures through a symbolic link: ${relative(ctx.baseDir, path)}`);
  }
}

async function fetchAndCapture(url, ctx) {
  const res = await ctx.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const contentType = res.headers.get('content-type') ?? '';
  const name = sha256(url).slice(0, 16);
  const bodyPath = join(ctx.capturesDir, `${name}.body`);
  const metaPath = join(ctx.capturesDir, `${name}.json`);
  const meta = {
    source: url,
    command: `curl -sSL ${shellQuote(url)}`,
    status: res.status,
    contentType,
    retrievedAt: new Date().toISOString(),
    sha256: sha256(body),
    body: relative(ctx.baseDir, bodyPath),
  };
  for (const path of [dirname(ctx.capturesDir), ctx.capturesDir, bodyPath, metaPath]) refuseSymlink(path, ctx);
  mkdirSync(ctx.capturesDir, { recursive: true });
  writeFileSync(bodyPath, body);
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  ctx.captures.push({ source: url, command: meta.command, path: meta.body, sha256: meta.sha256 });
  const text = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : body;
  return { text };
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Confirm the quote appears in the source. For an http(s) source that cannot be
// fetched, or whose premise declares the page is rendered by JavaScript, fall back
// to the premise's stored snapshot when its digest still matches.
async function checkQuote(premise, source, quote, where, ctx, report) {
  const needle = normalize(quote);
  let reason;
  let unreadable = false;
  try {
    const { text } = await readSource(source, ctx);
    if (normalize(text).includes(needle)) return true;
    reason = 'quote not found in source';
  } catch (err) {
    if (err instanceof InputError) throw err;
    reason = `source unreadable: ${err.message}`;
    unreadable = true;
  }
  if (where === 'quote' && premise.snapshot && (unreadable || premise.jsRendered)) {
    const snap = premise.snapshot;
    const file = isAbsolute(snap.path) ? snap.path : resolve(ctx.baseDir, snap.path);
    if (!existsSync(file)) {
      reason += `; snapshot ${snap.path} is missing`;
    } else {
      const raw = readFileSync(file, 'utf8');
      const digest = sha256(raw);
      if (digest !== snap.sha256) {
        reason += `; snapshot ${snap.path} digest ${digest} does not match the recorded ${snap.sha256}`;
      } else if (normalize(/\.html?$/i.test(file) ? htmlToText(raw) : raw).includes(needle)) {
        report.snapshotFallbacks.push({ id: premise.id, source, snapshot: snap.path, sha256: digest, reason });
        return true;
      } else {
        reason += `; quote not found in snapshot ${snap.path} either`;
      }
    }
  }
  report.missingQuotes.push({ id: premise.id, where, source, quote: needle, reason });
  return false;
}

// A test ID resolves when its exact text appears anywhere in one of the files
// matched by the ledger's testFiles globs. Directories a glob matches are skipped.
function loadTestText(ledger, baseDir) {
  const files = new Set();
  for (const pattern of ledger.testFiles ?? []) {
    for (const f of globSync(pattern, { cwd: baseDir, withFileTypes: true })) {
      if (f.isFile()) files.add(resolve(baseDir, f.parentPath, f.name));
    }
  }
  return [...files].sort().map((f) => ({ file: relative(baseDir, f), text: readFileSync(f, 'utf8') }));
}

function loadLedger(ledgerPath) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch (err) {
    fail(`cannot read ${ledgerPath}: ${err.message}`);
  }
  let ledger;
  try {
    ledger = JSON.parse(raw);
  } catch (err) {
    fail(`${ledgerPath} is not valid JSON: ${err.message}`);
  }
  return validate(ledger);
}

export async function check(ledgerPath, options = {}) {
  const ledger = loadLedger(ledgerPath);
  const baseDir = dirname(resolve(ledgerPath));
  const ctx = {
    baseDir,
    capturesDir: join(baseDir, '.premises', 'captures'),
    fetch: options.fetch ?? globalThis.fetch,
    cache: new Map(),
    captures: [],
  };
  const report = {
    ok: true,
    ledger: ledgerPath,
    counts: Object.fromEntries(VERDICTS.map((v) => [v, 0])),
    missingQuotes: [],
    unpinned: [],
    unknownTests: [],
    pinnedNotSupported: [],
    snapshotFallbacks: [],
    captures: ctx.captures,
    testFiles: [],
    premises: [],
  };
  const tests = loadTestText(ledger, baseDir);
  report.testFiles = tests.map((t) => t.file);

  for (const p of ledger.premises) {
    report.counts[p.verdict] += 1;
    const entry = { id: p.id, verdict: p.verdict, claim: p.claim, source: p.source ?? null, quoteFound: null };
    if (p.source !== undefined) {
      entry.quoteFound = await checkQuote(p, p.source, p.quote, 'quote', ctx, report);
    }
    if (p.paraphrasedIn?.length) {
      entry.paraphrasedIn = [];
      for (const [j, s] of p.paraphrasedIn.entries()) {
        const found = await checkQuote(p, s.source, s.quote, `paraphrasedIn[${j}]`, ctx, report);
        entry.paraphrasedIn.push({ source: s.source, quoteFound: found });
      }
    }
    if (p.note) entry.note = p.note;
    entry.tests = p.tests;
    report.premises.push(entry);

    for (const t of p.tests) {
      if (!tests.some((f) => f.text.includes(t))) report.unknownTests.push({ id: p.id, test: t });
    }
    if (p.tests.length === 0 && p.verdict === 'supported') report.unpinned.push(p.id);
    if (p.tests.length > 0 && p.verdict !== 'supported') {
      report.pinnedNotSupported.push({ id: p.id, verdict: p.verdict, tests: p.tests });
    }
  }
  report.ok = !report.missingQuotes.length && !report.unknownTests.length && !report.pinnedNotSupported.length;
  return report;
}

// One pass over a mutants find text, left to right. Each match is a string literal, a
// boolean, a comparison or equality operator, or a decimal number. Operators that are
// part of an arrow (=>, ->, <-) or a shift (<<, >>) are not comparisons.
const TOKEN = new RegExp([
  /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/.source,
  /\b(true|false|True|False)\b/.source,
  /(?<![<>=!-])(===|!==|==|!=|<=|>=|<(?![<-])|>(?!>))/.source,
  /(?<![\w.])(\d[\d_]*(?:\.\d+)?)(?![\w.])/.source,
].join('|'), 'g');
const FLIP = { true: 'false', false: 'true', True: 'False', False: 'True' };
const OPS = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==', '===': '!==', '!==': '===' };

// Add delta to a decimal literal such as 3, 60_000, or 0.25, keeping its precision.
function shiftNumber(literal, delta) {
  const [whole, fraction = ''] = literal.replaceAll('_', '').split('.');
  const value = BigInt(whole + fraction) + BigInt(delta) * 10n ** BigInt(fraction.length);
  if (!fraction) return String(value);
  const digits = (value < 0n ? -value : value).toString().padStart(fraction.length + 1, '0');
  return `${value < 0n ? '-' : ''}${digits.slice(0, -fraction.length)}.${digits.slice(-fraction.length)}`;
}

// List the mutations of a find text: each has the offset of the changed token in the
// text, the token, its replacement, and its kind.
export function mutationsOf(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const [from, str, bool, op, num] = m;
    const add = (to, kind) => out.push({ at: m.index, from, to, kind });
    if (str) add(`${str[0]}${str.slice(1, -1)}-mutant${str[0]}`, 'string');
    else if (bool) add(FLIP[bool], 'boolean');
    else if (op) add(OPS[op], /^[=!]/.test(op) ? 'equality' : 'comparison');
    else {
      add(shiftNumber(num, 1), 'number');
      if (/[1-9]/.test(num)) add(shiftNumber(num, -1), 'number');
    }
  }
  return out;
}

// Run argv without a shell in its own process group, so a timeout or a test runner that
// leaves child processes behind can be cleaned up in one kill. While it runs, its kill
// function is in the running set.
function runCommand(argv, cwd, timeoutMs, running) {
  return new Promise((done) => {
    const start = Date.now();
    const posix = process.platform !== 'win32';
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] });
    const killAll = () => {
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // The process group is already gone.
      }
    };
    let output = '';
    let timedOut = false;
    let error;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (d) => (output += d));
    }
    running.add(killAll);
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), killAll()), timeoutMs) : undefined;
    child.on('error', (err) => (error = err));
    child.on('exit', killAll);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      running.delete(killAll);
      done({ exitCode, timedOut, ms: Date.now() - start, output, error: error?.message });
    });
  });
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Find a premise's mutants target in the working copy. A target is invalid when its file
// is missing, or its find text does not occur exactly once or holds no value to mutate.
function resolveTarget(target, work, workReal) {
  const path = join(work, target.file);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { reason: 'file not found' };
  // The copy keeps symbolic links, and they point at the real tree. Never write through one.
  if (!realpathSync(path).startsWith(workReal + sep)) {
    fail(`refusing to mutate ${target.file} through a symbolic link, which would change files outside the temporary copy`);
  }
  if (!statSync(path).isFile()) return { reason: 'not a file' };
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const start = text.indexOf(target.find);
  if (start < 0) return { reason: 'find text not found' };
  if (text.indexOf(target.find, start + 1) >= 0) return { reason: 'find text found more than once' };
  const mutations = mutationsOf(target.find);
  if (!mutations.length) return { reason: 'no value to mutate' };
  return { path, bytes, text, start, mutations };
}

// Write a file and move its modification time at least a second forward, so tools that
// cache by size and time in seconds, such as Python's bytecode cache, see every change.
function writeChanged(path, data) {
  const before = Math.floor(statSync(path).mtimeMs / 1000);
  writeFileSync(path, data);
  const t = Math.max(Math.floor(Date.now() / 1000), before + 1);
  utimesSync(path, t, t);
}

export async function mutate(ledgerPath, options = {}) {
  const ledger = loadLedger(ledgerPath);
  if (ledger.testCommand === undefined) fail('ledger has no "testCommand", which mutate needs to run the linked tests');
  const minTimeoutMs = options.minTimeoutMs ?? MUTANT_MIN_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const baseDir = dirname(resolve(ledgerPath));
  const report = {
    ok: true,
    ledger: ledgerPath,
    selection: ledger.testCommand.some((a) => a.includes('{pattern}')) ? 'pattern' : 'suite',
    counts: { killed: 0, survived: 0, timedOut: 0 },
    survived: [],
    invalidMutants: [],
    noMutants: [],
    unpinned: [],
    premises: [],
  };
  const failedBaselines = [];
  // Work on a copy, so neither a crash nor a kill can leave a mutant in the real tree.
  const temp = mkdtempSync(join(tmpdir(), 'premises-mutate-'));
  // The tests run in their own process group, which an interrupt from the terminal does
  // not reach, so stop them and remove the copy before exiting on the same signal.
  const running = new Set();
  const interrupt = (signal) => {
    for (const killAll of running) killAll();
    rmSync(temp, { recursive: true, force: true });
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const work = join(temp, basename(baseDir) || 'root');
    cpSync(baseDir, work, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (src) => !['.git', '.premises'].includes(basename(src)),
    });
    const workReal = realpathSync(work);
    for (const p of ledger.premises) {
      if (p.verdict !== 'supported') continue;
      if (!p.mutants?.length) {
        if (p.tests.length) report.noMutants.push(p.id);
        continue;
      }
      if (!p.tests.length) {
        report.unpinned.push(p.id);
        continue;
      }
      const targets = [];
      for (const t of p.mutants) {
        const target = resolveTarget(t, work, workReal);
        if (target.reason) report.invalidMutants.push({ id: p.id, file: t.file, find: t.find, reason: target.reason });
        else targets.push({ ...t, ...target });
      }
      if (!targets.length) continue;

      const pattern = p.tests.map(escapeRegExp).join('|');
      const argv = ledger.testCommand.map((a) => a.replaceAll('{pattern}', pattern));
      const baseline = await runCommand(argv, work, 0, running);
      const entry = {
        id: p.id,
        tests: p.tests,
        baseline: {
          exitCode: baseline.exitCode,
          ms: baseline.ms,
          testsNotSeen: p.tests.filter((t) => !baseline.output.includes(t)),
        },
        mutants: [],
      };
      report.premises.push(entry);
      if (baseline.exitCode !== 0) {
        entry.baseline.output = (baseline.error ? `${baseline.error}\n` : '') + baseline.output.slice(-2000);
        failedBaselines.push(p.id);
        log(`${p.id}  baseline failed with exit code ${baseline.exitCode}\n`);
        continue;
      }
      const timeoutMs = Math.max(minTimeoutMs, 3 * baseline.ms);
      for (const t of targets) {
        for (const m of t.mutations) {
          const mutated = t.find.slice(0, m.at) + m.to + t.find.slice(m.at + m.from.length);
          const line = t.text.slice(0, t.start + m.at).split('\n').length;
          let r;
          try {
            writeChanged(t.path, t.text.slice(0, t.start) + mutated + t.text.slice(t.start + t.find.length));
            r = await runCommand(argv, work, timeoutMs, running);
          } finally {
            writeChanged(t.path, t.bytes);
          }
          const result = r.timedOut ? 'timedOut' : r.exitCode === 0 ? 'survived' : 'killed';
          report.counts[result] += 1;
          const row = { file: t.file, line, kind: m.kind, from: m.from, to: m.to, result, ms: r.ms };
          entry.mutants.push(row);
          if (result === 'survived') report.survived.push({ id: p.id, file: t.file, line, kind: m.kind, from: m.from, to: m.to, mutated });
          log(`${p.id}  ${t.file}:${line}  ${m.from} -> ${m.to}  ${result}  ${r.ms}ms\n`);
        }
      }
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    rmSync(temp, { recursive: true, force: true });
  }
  if (failedBaselines.length) {
    report.error = `the linked tests fail before any mutation for ${failedBaselines.join(', ')}`;
  }
  report.ok = !report.error && !report.survived.length && !report.invalidMutants.length;
  return report;
}

export async function main(args, io = { out: stdout, err: stderr }, options = {}) {
  const [command, ...rest] = args;
  if (command === '-h' || command === '--help' || command === 'help') {
    io.out.write(`${USAGE}\n`);
    return 0;
  }
  if (command !== 'check' && command !== 'mutate') {
    io.err.write(`${USAGE}\n`);
    return 2;
  }
  const unexpected = rest.find((a, i) => i > 0 || a.startsWith('-'));
  if (unexpected !== undefined) {
    io.err.write(`unexpected argument: ${unexpected}\n${USAGE}\n`);
    return 2;
  }
  let target = rest[0] ?? 'premises.json';
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'premises.json');
  try {
    const report = command === 'check'
      ? await check(target, options)
      : await mutate(target, { log: (line) => io.err.write(line), ...options });
    io.out.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.error) return 2;
    return report.ok ? 0 : 1;
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    io.out.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
    return 2;
  }
}

if (argv[1] && realpathSync(argv[1]) === fileURLToPath(import.meta.url)) {
  main(argv.slice(2)).then(exit, (err) => {
    stderr.write(`premises: ${err.stack ?? err}\n`);
    exit(2);
  });
}
