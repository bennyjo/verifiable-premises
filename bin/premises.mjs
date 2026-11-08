#!/usr/bin/env node
// premises: re-check every premise in a premises.json ledger against its quoted source.
// Dependency-free: Node 22.17 or later, standard library only.
// Exit codes: 0 all quotes found and all links valid, 1 findings, 2 usage or input error.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const VERDICTS = ['supported', 'contradicted', 'unsupported'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FETCH_TIMEOUT_MS = 15000;
const LEDGER_KEYS = ['$schema', 'task', 'testFiles', 'premises'];
const PREMISE_KEYS = ['id', 'claim', 'source', 'quote', 'retrieved', 'verdict', 'tests', 'paraphrasedIn', 'snapshot', 'jsRendered', 'note'];

const USAGE = `Usage: premises check [path]

Checks the premises.json ledger at path (default: ./premises.json, or path/premises.json
when path is a directory) and prints a JSON report.

Exit codes:
  0  every quote was found and every test link is valid
  1  a quote is missing or changed, a listed test does not exist, or a test pins
     a premise whose verdict is not "supported"
  2  usage or input error (bad arguments, unreadable or invalid premises.json,
     a symbolic link in the path of an HTTP capture)`;

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

export async function check(ledgerPath, options = {}) {
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
  validate(ledger);
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

export async function main(args, io = { out: stdout, err: stderr }, options = {}) {
  const [command, ...rest] = args;
  if (command === '-h' || command === '--help' || command === 'help') {
    io.out.write(`${USAGE}\n`);
    return 0;
  }
  if (command !== 'check') {
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
    const report = await check(target, options);
    io.out.write(`${JSON.stringify(report, null, 2)}\n`);
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
