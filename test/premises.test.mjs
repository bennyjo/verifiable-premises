// Tests for bin/premises.mjs. They never touch the network: HTTP sources are served
// by a local server on 127.0.0.1.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { htmlToText, main, mutationsOf, normalize, sha256, validate } from '../bin/premises.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'premises.mjs');
const EXAMPLE = join(ROOT, 'examples', 'webhook-retries');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'premises-test-'));
}

// Write a ledger and its files into a fresh directory and return the directory.
function fixture(ledger, files = {}) {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  writeFileSync(join(dir, 'premises.json'), JSON.stringify(ledger, null, 2));
  return dir;
}

function premise(fields) {
  return { id: 'p1', claim: 'A claim.', retrieved: '2026-10-25', verdict: 'supported', tests: [], ...fields };
}

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, report: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null, stdout: r.stdout, stderr: r.stderr };
}

// Run the checker in-process, so tests can serve HTTP from the same process.
async function run(dir) {
  let out = '';
  const io = { out: { write: (s) => (out += s) }, err: { write: () => {} } };
  const code = await main(['check', dir], io);
  return { code, report: JSON.parse(out) };
}

describe('normalize and htmlToText', () => {
  test('collapses whitespace runs and trims', () => {
    assert.equal(normalize('  a\n\tb   c \n'), 'a b c');
  });

  test('drops tags, scripts, and decodes entities', () => {
    const html = '<p>Rate&nbsp;limit is <b>100</b> &amp; resets</p><script>var x = "<p>no</p>";</script>&#39;ok&#x27;';
    assert.equal(normalize(htmlToText(html)), "Rate limit is 100 & resets 'ok'");
  });

  test('joins inline tags to adjacent punctuation and separates block tags', () => {
    const html = '<h2>Limits</h2><p>Set <code>limit</code>.</p><p>Read <a href="/d">docs</a>, then<br>retry.</p><ul><li>one</li><li>two</li></ul>';
    assert.equal(normalize(htmlToText(html)), 'Limits Set limit. Read docs, then retry. one two');
  });

  test('joins text on each side of comments and hidden elements', () => {
    const html = '<p>Set <!-- -->limit<!-- -->. Use v<script>x()</script>2<style>p{}</style>.</p>';
    assert.equal(normalize(htmlToText(html)), 'Set limit. Use v2.');
  });

  test('decodes common named typographic entities, so a browser-copied quote matches', () => {
    const html = '<p>Don&rsquo;t retry &mdash; ever&hellip; &lsquo;a&rsquo; &ldquo;b&rdquo; 1&ndash;3</p>';
    assert.equal(normalize(htmlToText(html)), 'Don\u2019t retry \u2014 ever\u2026 \u2018a\u2019 \u201Cb\u201D 1\u20133');
  });

  test('leaves a numeric entity that names no code point as text', () => {
    assert.equal(htmlToText('a &#xFFFFFFFF; b &#9999999999; c &#x41;'), 'a &#xFFFFFFFF; b &#9999999999; c A');
  });
});

describe('webhook retries example', () => {
  test('passes and shows the design report as the source the contract paraphrases', () => {
    const { code, report } = cli('check', EXAMPLE);
    assert.equal(code, 0);
    assert.equal(report.ok, true);
    assert.deepEqual(report.counts, { supported: 5, contradicted: 3, unsupported: 0 });
    assert.deepEqual(report.missingQuotes, []);
    assert.deepEqual(report.testFiles, [], 'the ledger is written before any test exists');
    const cap = report.premises.find((p) => p.id === 'retry-cap');
    assert.equal(cap.source, 'sources/design-report.md');
    assert.equal(cap.quoteFound, true);
    assert.deepEqual(cap.paraphrasedIn, [{ source: 'sources/contract.md', quoteFound: true }]);
    assert.ok(report.unpinned.includes('retry-cap'));
    const contradicted = report.premises.filter((p) => p.verdict === 'contradicted').map((p) => p.id);
    assert.deepEqual(contradicted, ['payment-ten-second-retry', 'order-timeout-class', 'account-retry-gone']);
  });

  test('adversarial: replacing one word in one quote exits 1', () => {
    const dir = tempDir();
    cpSync(EXAMPLE, dir, { recursive: true });
    const path = join(dir, 'premises.json');
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    const cap = ledger.premises.find((p) => p.id === 'retry-cap');
    cap.quote = cap.quote.replace('at most three retries', 'at most four retries');
    writeFileSync(path, JSON.stringify(ledger, null, 2));
    const { code, report } = cli('check', dir);
    assert.equal(code, 1);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingQuotes.map((m) => [m.id, m.where]), [['retry-cap', 'quote']]);
  });

  test('adversarial: an edited paraphrase quote also exits 1', () => {
    const dir = tempDir();
    cpSync(EXAMPLE, dir, { recursive: true });
    const path = join(dir, 'premises.json');
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    const p = ledger.premises.find((x) => x.id === 'account-retry-gone');
    p.paraphrasedIn[0].quote = p.paraphrasedIn[0].quote.replace('410 Gone', '404 Not Found');
    writeFileSync(path, JSON.stringify(ledger, null, 2));
    const { code, report } = cli('check', dir);
    assert.equal(code, 1);
    assert.deepEqual(report.missingQuotes.map((m) => [m.id, m.where]), [['account-retry-gone', 'paraphrasedIn[0]']]);
  });
});

describe('local file sources', () => {
  const doc = 'The API allows 100 requests\nper minute per token.\n';

  test('a quote with non-ASCII characters matches', async () => {
    const text = 'Caf\u00E9 retries \u2014 na\u00EFve backoff \u2026 done.\n';
    const dir = fixture({ premises: [premise({ source: 'doc.md', quote: 'Caf\u00E9 retries \u2014 na\u00EFve backoff' })] }, { 'doc.md': text });
    const { code, report } = await run(dir);
    assert.equal(code, 0);
    assert.equal(report.premises[0].quoteFound, true);
  });

  test('a quote that wraps across lines matches', async () => {
    const dir = fixture({ premises: [premise({ source: 'doc.md', quote: 'allows 100 requests per   minute' })] }, { 'doc.md': doc });
    const { code, report } = await run(dir);
    assert.equal(code, 0);
    assert.equal(report.premises[0].quoteFound, true);
  });

  test('an invented quote exits 1', async () => {
    const dir = fixture({ premises: [premise({ source: 'doc.md', quote: 'allows 1000 requests per minute' })] }, { 'doc.md': doc });
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.equal(report.missingQuotes[0].reason, 'quote not found in source');
  });

  test('a missing source file exits 1 with the reason', async () => {
    const dir = fixture({ premises: [premise({ source: 'gone.md', quote: 'x' })] });
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.match(report.missingQuotes[0].reason, /^source unreadable: ENOENT/);
  });
});

describe('git sources', () => {
  test('reads the file at a ref, not the working copy', async () => {
    const dir = tempDir();
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(dir, 'spec.md'), 'Tokens expire after 24 hours.\n');
    git('add', 'spec.md');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'spec');
    git('tag', 'v1');
    writeFileSync(join(dir, 'spec.md'), 'Tokens expire after 1 hour.\n');
    writeFileSync(join(dir, 'premises.json'), JSON.stringify({
      premises: [
        premise({ id: 'old', source: 'git:v1:spec.md', quote: 'expire after 24 hours' }),
        premise({ id: 'new', source: 'git:v1:spec.md', quote: 'expire after 1 hour' }),
        premise({ id: 'bad', source: 'git:nope:spec.md', quote: 'expire' }),
      ],
    }));
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.deepEqual(report.missingQuotes.map((m) => m.id), ['new', 'bad']);
    assert.match(report.missingQuotes[1].reason, /^source unreadable: git show nope:spec.md failed/);
  });

  test('treats a ref that looks like an option as a ref, so it cannot write files', async () => {
    const dir = tempDir();
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(dir, 'spec.md'), 'Tokens expire after 24 hours.\n');
    git('add', 'spec.md');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'spec');
    const target = join(tempDir(), 'written');
    writeFileSync(join(dir, 'premises.json'), JSON.stringify({
      premises: [premise({ source: `git:--output=${target}:HEAD`, quote: 'expire' })],
    }));
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.equal(existsSync(`${target}:HEAD`), false, 'git show must not write the --output file');
    assert.match(report.missingQuotes[0].reason, /^source unreadable: git show --output=/);
  });
});

describe('test links', () => {
  const files = {
    'doc.md': 'Retries stop after 3 attempts.',
    'tests/retry.test.js': "test('retry-stops-at-3', () => {});\n",
  };
  const quote = { source: 'doc.md', quote: 'Retries stop after 3 attempts.' };

  test('a listed test found in testFiles links, and an unlisted premise is unpinned', async () => {
    const dir = fixture({
      testFiles: ['tests/**/*.test.js'],
      premises: [premise({ id: 'a', ...quote, tests: ['retry-stops-at-3'] }), premise({ id: 'b', ...quote })],
    }, files);
    const { code, report } = await run(dir);
    assert.equal(code, 0);
    assert.deepEqual(report.testFiles, ['tests/retry.test.js']);
    assert.deepEqual(report.unpinned, ['b']);
    assert.deepEqual(report.unknownTests, []);
  });

  test('a glob that also matches directories reads only the files', async () => {
    const dir = fixture({ testFiles: ['tests/**'], premises: [premise({ ...quote, tests: ['retry-stops-at-3'] })] }, files);
    const { code, report } = await run(dir);
    assert.equal(code, 0);
    assert.deepEqual(report.testFiles, ['tests/retry.test.js']);
  });

  test('a listed test that does not exist exits 1', async () => {
    const dir = fixture({ testFiles: ['tests/*.test.js'], premises: [premise({ ...quote, tests: ['retry-stops-at-5'] })] }, files);
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.deepEqual(report.unknownTests, [{ id: 'p1', test: 'retry-stops-at-5' }]);
  });

  test('an unsupported or contradicted premise pinned by a test exits 1', async () => {
    const dir = fixture({
      testFiles: ['tests/*.test.js'],
      premises: [
        premise({ id: 'u', verdict: 'unsupported', retrieved: undefined, tests: ['retry-stops-at-3'] }),
        premise({ id: 'c', verdict: 'contradicted', ...quote, tests: ['retry-stops-at-3'] }),
        premise({ id: 'u2', verdict: 'unsupported', retrieved: undefined }),
      ],
    }, files);
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.deepEqual(report.pinnedNotSupported.map((p) => [p.id, p.verdict]), [['u', 'unsupported'], ['c', 'contradicted']]);
    assert.deepEqual(report.counts, { supported: 0, contradicted: 1, unsupported: 2 });
    assert.deepEqual(report.unpinned, []);
  });
});

describe('http sources', () => {
  let server;
  let base;
  const pages = {
    '/docs': ['text/html', '<html><body><h1>Limits</h1><p>Each key may send <em>60</em>\n requests a minute.</p></body></html>'],
    '/app': ['text/html', '<html><body><div id="root"></div><script src="/app.js"></script></body></html>'],
    '/plain': ['text/plain', 'Uploads are capped at 10 MB.'],
  };

  before(async () => {
    server = createServer((req, res) => {
      const page = pages[req.url];
      res.writeHead(page ? 200 : 404, { 'content-type': page ? page[0] : 'text/plain' });
      res.end(page ? page[1] : 'not found');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  test('fetches, matches visible text, and stores the response with its command', async () => {
    const dir = fixture({
      premises: [
        premise({ id: 'h', source: `${base}/docs`, quote: 'Each key may send 60 requests a minute.' }),
        premise({ id: 't', source: `${base}/plain`, quote: 'capped at 10 MB' }),
      ],
    });
    const { code, report } = await run(dir);
    assert.equal(code, 0);
    assert.equal(report.captures.length, 2);
    const cap = report.captures.find((c) => c.source === `${base}/docs`);
    assert.equal(cap.command, `curl -sSL '${base}/docs'`);
    assert.equal(cap.sha256, sha256(pages['/docs'][1]));
    assert.equal(readFileSync(join(dir, cap.path), 'utf8'), pages['/docs'][1]);
    const meta = JSON.parse(readFileSync(join(dir, cap.path.replace(/\.body$/, '.json')), 'utf8'));
    assert.equal(meta.status, 200);
    assert.equal(meta.command, cap.command);
  });

  test('a page rendered by JavaScript falls back to a snapshot whose digest matches, and says so', async () => {
    const snapshot = '<p>Each key may send 60 requests a minute.</p>';
    const dir = fixture({
      premises: [premise({ source: `${base}/app`, quote: 'send 60 requests a minute', jsRendered: true, snapshot: { path: 'snap/app.html', sha256: sha256(snapshot) } })],
    }, { 'snap/app.html': snapshot });
    const { code, report } = await run(dir);
    assert.equal(code, 0);
    assert.equal(report.snapshotFallbacks.length, 1);
    assert.equal(report.snapshotFallbacks[0].reason, 'quote not found in source');
    assert.equal(report.snapshotFallbacks[0].sha256, sha256(snapshot));
  });

  test('a page that loads without the quote exits 1 when the premise is not jsRendered, despite a snapshot', async () => {
    const snapshot = 'Each key may send 60 requests a minute.';
    const dir = fixture({
      premises: [premise({ source: `${base}/plain`, quote: 'send 60 requests a minute', snapshot: { path: 'snap.txt', sha256: sha256(snapshot) } })],
    }, { 'snap.txt': snapshot });
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.equal(report.missingQuotes[0].reason, 'quote not found in source');
    assert.deepEqual(report.snapshotFallbacks, []);
  });

  test('a snapshot whose digest no longer matches exits 1', async () => {
    const dir = fixture({
      premises: [premise({ source: `${base}/app`, quote: 'send 60 requests a minute', jsRendered: true, snapshot: { path: 'snap.html', sha256: sha256('original') } })],
    }, { 'snap.html': '<p>Each key may send 60 requests a minute.</p>' });
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.match(report.missingQuotes[0].reason, /digest .* does not match the recorded/);
    assert.deepEqual(report.snapshotFallbacks, []);
  });

  test('an HTTP error exits 1, or falls back to a snapshot', async () => {
    const snapshot = 'Each key may send 60 requests a minute.';
    const dir = fixture({
      premises: [
        premise({ id: 'no-snap', source: `${base}/gone`, quote: 'send 60 requests' }),
        premise({ id: 'snap', source: `${base}/gone`, quote: 'send 60 requests', snapshot: { path: 'snap.txt', sha256: sha256(snapshot) } }),
      ],
    }, { 'snap.txt': snapshot });
    const { code, report } = await run(dir);
    assert.equal(code, 1);
    assert.deepEqual(report.missingQuotes.map((m) => m.id), ['no-snap']);
    assert.match(report.missingQuotes[0].reason, /HTTP 404/);
    assert.deepEqual(report.snapshotFallbacks.map((s) => s.id), ['snap']);
    assert.match(report.snapshotFallbacks[0].reason, /source unreadable: HTTP 404/);
    assert.equal(report.captures.length, 0, 'an error response is not stored as evidence');
  });

  // Git can carry a symlink in a cloned repository, and the capture name is predictable.
  // Each premise has a valid snapshot, so a fallback must not hide the refusal.
  for (const [label, link, target] of [
    ['.premises', () => '.premises', 'elsewhere'],
    ['captures', () => '.premises/captures', 'elsewhere'],
    ['a capture body', (name) => `.premises/captures/${name}.body`, 'elsewhere/stolen'],
    ['a capture record', (name) => `.premises/captures/${name}.json`, 'elsewhere/stolen'],
  ]) {
    test(`a symlink at ${label} exits 2 and writes nothing through it`, async () => {
      const snapshot = 'Uploads are capped at 10 MB.';
      const url = `${base}/plain`;
      const dir = fixture({
        premises: [premise({ source: url, quote: 'capped at 10 MB', snapshot: { path: 'snap.txt', sha256: sha256(snapshot) } })],
      }, { 'snap.txt': snapshot, 'elsewhere/.keep': '' });
      const path = join(dir, link(sha256(url).slice(0, 16)));
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(join(dir, target), path);
      const { code, report } = await run(dir);
      assert.equal(code, 2);
      assert.match(report.error, /symbolic link/);
      assert.deepEqual(readdirSync(join(dir, 'elsewhere')), ['.keep']);
    });
  }
});

describe('usage and input errors exit 2', () => {
  test('unknown command', () => {
    assert.equal(cli('verify').code, 2);
  });

  test('missing ledger', () => {
    const r = cli('check', join(tempDir(), 'premises.json'));
    assert.equal(r.code, 2);
    assert.match(r.report.error, /cannot read/);
  });

  test('an option or a second path', () => {
    assert.equal(cli('check', EXAMPLE, '--captures', 'out').code, 2);
    assert.equal(cli('check', EXAMPLE, EXAMPLE).code, 2);
  });

  test('invalid JSON', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'premises.json'), '{ nope');
    assert.equal(cli('check', dir).code, 2);
  });

  for (const [name, bad, message] of [
    ['bad verdict', premise({ source: 'a', quote: 'b', verdict: 'likely' }), /verdict must be one of/],
    ['missing quote', premise({ source: 'a' }), /quote must be a non-empty string/],
    ['bad date', premise({ source: 'a', quote: 'b', retrieved: '25 Oct' }), /retrieved must be a YYYY-MM-DD date/],
    ['unknown field', premise({ source: 'a', quote: 'b', url: 'x' }), /unknown field "url"/],
    ['snapshot on a file source', premise({ source: 'a', quote: 'b', snapshot: { path: 's', sha256: sha256('') } }), /only allowed for http/],
    ['jsRendered without a snapshot', premise({ source: 'http://x', quote: 'b', jsRendered: true }), /jsRendered requires a snapshot/],
    ['jsRendered not a boolean', premise({ source: 'http://x', quote: 'b', jsRendered: 'yes', snapshot: { path: 's', sha256: sha256('') } }), /jsRendered must be a boolean/],
    ['mutants on a contradicted premise', premise({ source: 'a', quote: 'b', verdict: 'contradicted', mutants: [{ file: 'a.js', find: '3' }] }), /mutants is only allowed on a supported premise/],
    ['mutants file outside the ledger directory', premise({ source: 'a', quote: 'b', mutants: [{ file: 'src/../../a.js', find: '3' }] }), /file must be a relative path inside/],
    ['mutants file with an absolute path', premise({ source: 'a', quote: 'b', mutants: [{ file: '/etc/a.js', find: '3' }] }), /file must be a relative path inside/],
    ['mutants without find', premise({ source: 'a', quote: 'b', mutants: [{ file: 'a.js' }] }), /find must be a non-empty string/],
    ['mutants with an unknown field', premise({ source: 'a', quote: 'b', mutants: [{ file: 'a.js', find: '3', line: 4 }] }), /unknown field "line"/],
  ]) {
    test(name, () => {
      const r = cli('check', fixture({ premises: [bad] }));
      assert.equal(r.code, 2);
      assert.match(r.report.error, message);
    });
  }

  for (const [name, testCommand] of [['empty', []], ['an empty argument', ['node', '']], ['a string', 'npm test']]) {
    test(`testCommand that is ${name}`, () => {
      const r = cli('check', fixture({ testCommand, premises: [] }));
      assert.equal(r.code, 2);
      assert.match(r.report.error, /"testCommand" must be a non-empty array of non-empty strings/);
    });
  }

  test('duplicate IDs', () => {
    const p = premise({ source: 'a', quote: 'b' });
    const r = cli('check', fixture({ premises: [p, p] }));
    assert.equal(r.code, 2);
    assert.match(r.report.error, /duplicate/);
  });
});

describe('schema and validator agree', () => {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'premises.schema.json'), 'utf8'));
  const samples = {
    id: 'p1',
    claim: 'A claim.',
    source: 'https://example.com/docs',
    quote: 'a quote',
    retrieved: '2026-10-25',
    verdict: 'supported',
    tests: ['t1'],
    paraphrasedIn: [{ source: 'contract.md', quote: 'a paraphrase' }],
    snapshot: { path: 'snap.txt', sha256: sha256('') },
    jsRendered: true,
    note: 'A note.',
    mutants: [{ file: 'src/retry.mjs', find: 'MAX_RETRIES = 3' }],
  };

  test('the validator accepts every premise field the schema lists', () => {
    const fields = Object.keys(schema.$defs.premise.properties);
    assert.deepEqual(fields.filter((f) => !(f in samples)), [], 'add a sample for each new schema field');
    for (const field of fields) {
      const p = premise({ source: 'https://example.com/docs', quote: 'a quote', snapshot: samples.snapshot, [field]: samples[field] });
      assert.doesNotThrow(() => validate({ premises: [p] }), field);
    }
  });

  test('the validator rejects a premise field the schema does not list', () => {
    assert.throws(() => validate({ premises: [premise({ source: 'a', quote: 'b', extra: 1 })] }), /unknown field "extra"/);
  });

  test('both reject whitespace-only claims, quotes, and test IDs', () => {
    const props = schema.$defs.premise.properties;
    for (const [name, rule, fields] of [
      ['claim', props.claim, { source: 'a', quote: 'b', claim: ' \n ' }],
      ['quote', props.quote, { source: 'a', quote: ' \t ' }],
      ['tests', props.tests.items, { source: 'a', quote: 'b', tests: ['  '] }],
      ['paraphrasedIn quote', props.paraphrasedIn.items.properties.quote, { source: 'a', quote: 'b', paraphrasedIn: [{ source: 'c', quote: '  ' }] }],
      ['mutants find', props.mutants.items.properties.find, { source: 'a', quote: 'b', mutants: [{ file: 'a.js', find: ' \t ' }] }],
    ]) {
      assert.equal(new RegExp(rule.pattern, 'u').test(' \n\t '), false, `schema accepts a blank ${name}`);
      assert.throws(() => validate({ premises: [premise(fields)] }), /non-empty/, name);
    }
  });

  test('both accept testCommand at the ledger level', () => {
    assert.deepEqual(schema.properties.testCommand.items, { type: 'string', minLength: 1 });
    assert.doesNotThrow(() => validate({ testCommand: ['node', '--test'], premises: [] }));
  });

  test('both allow mutants only on a supported premise', () => {
    const rule = schema.$defs.premise.allOf.find((r) => r.then?.properties?.mutants === false);
    assert.deepEqual(rule.if.properties.verdict, { not: { const: 'supported' } });
    for (const verdict of ['contradicted', 'unsupported']) {
      assert.throws(() => validate({ premises: [premise({ source: 'a', quote: 'b', verdict, mutants: [] })] }), /only allowed on a supported/);
    }
  });

  test('both accept a mutants file only inside the ledger directory', () => {
    const pattern = new RegExp(schema.$defs.premise.properties.mutants.items.properties.file.pattern, 'u');
    const check = (file) => () => validate({ premises: [premise({ source: 'a', quote: 'b', mutants: [{ file, find: '3' }] })] });
    for (const file of ['retry.mjs', 'src/retry.mjs', 'src/a..b.mjs', './src/retry.mjs']) {
      assert.equal(pattern.test(file), true, file);
      assert.doesNotThrow(check(file), file);
    }
    for (const file of ['', '..', '../retry.mjs', 'src/../../retry.mjs', 'src\\..\\..\\retry.mjs', '/src/retry.mjs', 'C:\\retry.mjs']) {
      assert.equal(pattern.test(file), false, file);
      assert.throws(check(file), /inside the ledger's directory/, file);
    }
  });

  test('both allow a snapshot only on an http(s) source', () => {
    const rule = schema.$defs.premise.allOf.find((r) => r.if?.required?.includes('snapshot'));
    assert.deepEqual(rule.then.required, ['source']);
    const pattern = new RegExp(rule.then.properties.source.pattern, 'u');
    for (const source of ['https://example.com/docs', 'http://example.com/docs']) {
      assert.equal(pattern.test(source), true, source);
      assert.doesNotThrow(() => validate({ premises: [premise({ source, quote: 'b', snapshot: samples.snapshot })] }), source);
    }
    for (const source of ['docs.md', 'git:main:docs.md']) {
      assert.equal(pattern.test(source), false, source);
      assert.throws(() => validate({ premises: [premise({ source, quote: 'b', snapshot: samples.snapshot })] }), /only allowed for http/, source);
    }
  });
});

describe('mutate', () => {
  // These tests run under node --test, which tells its child processes to report to it.
  // The test commands below start their own runner, so they must not inherit that.
  before(() => delete process.env.NODE_TEST_CONTEXT);

  const RETRY = [
    'export const MAX_RETRIES = 3;',
    'export const SCHEDULE = { payment: [60_000, 600_000] };',
    '',
    'export function shouldRetry(attempt) {',
    '  return attempt <= MAX_RETRIES;',
    '}',
    '',
  ].join('\n');
  const CAP = 'retry-cap: allows the third retry and refuses the fourth';
  const PAYMENT = 'payment-schedule: waits one minute, then ten';
  const header = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { SCHEDULE, shouldRetry } from '../src/retry.mjs';\n";
  const capTest = `test('${CAP}', () => {\n  assert.equal(shouldRetry(3), true);\n  assert.equal(shouldRetry(4), false);\n});\n`;
  const strongPayment = `test('${PAYMENT}', () => {\n  assert.deepEqual(SCHEDULE.payment, [60_000, 600_000]);\n});\n`;
  const weakPayment = `test('${PAYMENT}', () => {\n  assert.equal(SCHEDULE.payment.length, 2);\n});\n`;
  const PATTERN_COMMAND = [process.execPath, '--test', '--test-name-pattern', '{pattern}', 'test/*.test.mjs'];
  const SUITE_COMMAND = [process.execPath, '--test', 'test/*.test.mjs'];
  const source = { source: 'design.md', quote: 'At most three retries.' };

  function project({ tests = header + capTest + strongPayment, testCommand = PATTERN_COMMAND, premises, files = {} }) {
    return fixture({ testFiles: ['test/*.test.mjs'], testCommand, premises }, {
      'design.md': 'At most three retries.\n',
      'src/retry.mjs': RETRY,
      'test/retry.test.mjs': tests,
      ...files,
    });
  }

  const capPremise = (fields = {}) => premise({
    id: 'retry-cap',
    ...source,
    tests: [CAP],
    mutants: [{ file: 'src/retry.mjs', find: 'MAX_RETRIES = 3' }, { file: 'src/retry.mjs', find: 'attempt <= MAX_RETRIES' }],
    ...fields,
  });
  const paymentPremise = (fields = {}) => premise({
    id: 'payment-schedule',
    ...source,
    tests: [PAYMENT],
    mutants: [{ file: 'src/retry.mjs', find: '[60_000, 600_000]' }],
    ...fields,
  });

  async function mutate(dir, options = {}) {
    let out = '';
    let err = '';
    const io = { out: { write: (s) => (out += s) }, err: { write: (s) => (err += s) } };
    const code = await main(['mutate', dir], io, options);
    return { code, report: JSON.parse(out), progress: err.split('\n').filter(Boolean) };
  }

  // Every file under dir with its bytes and modification time.
  function tree(dir) {
    return readdirSync(dir, { recursive: true }).sort().map((f) => {
      const path = join(dir, f);
      const stat = statSync(path);
      return [f, stat.mtimeMs, stat.isFile() ? readFileSync(path, 'utf8') : null];
    });
  }

  test('lists the value mutations of numbers, comparisons, equality, booleans, and strings', () => {
    const row = (m) => `${m.from} -> ${m.to} (${m.kind})`;
    assert.deepEqual(mutationsOf('failures >= 20 && hours > 6.5').map(row), [
      '>= -> > (comparison)', '20 -> 21 (number)', '20 -> 19 (number)', '> -> >= (comparison)', '6.5 -> 7.5 (number)', '6.5 -> 5.5 (number)',
    ]);
    assert.deepEqual(mutationsOf("kind === 'payment' && x != 0 && on == True").map(row), [
      '=== -> !== (equality)', "'payment' -> 'payment-mutant' (string)", '!= -> == (equality)', '0 -> 1 (number)', '== -> != (equality)', 'True -> False (boolean)',
    ]);
    assert.deepEqual(mutationsOf('delay = 60_000; retry = false; a < b').map(row), [
      '60_000 -> 60001 (number)', '60_000 -> 59999 (number)', 'false -> true (boolean)', '< -> <= (comparison)',
    ]);
    assert.equal(mutationsOf('const f = (a) => a << 2 >> 1, v2, 0x1F, 1e3, 9n, x <- ch')
      .map(row).join(', '), '2 -> 3 (number), 2 -> 1 (number), 1 -> 2 (number), 1 -> 0 (number)',
    'arrows, shifts, identifiers, and hex, exponent, and BigInt literals are left alone');
    assert.deepEqual(mutationsOf(`"it's 3" + 'say "4"'`).map((m) => m.to), [`"it's 3-mutant"`, `'say "4"-mutant'`]);
    assert.deepEqual(mutationsOf('x - 0.25').map((m) => m.to), ['1.25', '-0.75']);
  });

  test('strong linked tests kill every mutant, and the source tree is unchanged', async () => {
    const dir = project({ premises: [capPremise(), paymentPremise()] });
    const before = tree(dir);
    const { code, report, progress } = await mutate(dir);
    assert.equal(code, 0, JSON.stringify(report, null, 2));
    assert.equal(report.ok, true);
    assert.equal(report.selection, 'pattern');
    assert.deepEqual(report.counts, { killed: 7, survived: 0, timedOut: 0 });
    assert.deepEqual(report.survived, []);
    const cap = report.premises.find((p) => p.id === 'retry-cap');
    assert.deepEqual(cap.baseline.testsNotSeen, []);
    assert.equal(cap.baseline.exitCode, 0);
    assert.deepEqual(cap.mutants.map((m) => [m.line, m.kind, m.from, m.to, m.result]), [
      [1, 'number', '3', '4', 'killed'],
      [1, 'number', '3', '2', 'killed'],
      [5, 'comparison', '<=', '<', 'killed'],
    ]);
    assert.equal(progress.length, 7);
    assert.match(progress[0], /^retry-cap {2}src\/retry\.mjs:1 {2}3 -> 4 {2}killed {2}\d+ms$/);
    assert.deepEqual(tree(dir), before, 'mutate never writes to the ledger directory');
  });

  test('weak linked tests leave survivors and exit 1', async () => {
    const dir = project({ tests: header + capTest + weakPayment, premises: [capPremise(), paymentPremise()] });
    const { code, report } = await mutate(dir);
    assert.equal(code, 1);
    assert.equal(report.ok, false);
    assert.deepEqual(report.counts, { killed: 3, survived: 4, timedOut: 0 });
    assert.deepEqual(report.survived[0], {
      id: 'payment-schedule', file: 'src/retry.mjs', line: 2, kind: 'number', from: '60_000', to: '60001', mutated: '[60001, 600_000]',
    });
    assert.deepEqual(report.survived.map((s) => s.to), ['60001', '59999', '600001', '599999']);
  });

  test('runs only the linked tests, so a mutant that only an unlinked test catches survives', async () => {
    const wrongLink = paymentPremise({ mutants: [{ file: 'src/retry.mjs', find: 'MAX_RETRIES = 3' }] });
    const scoped = await mutate(project({ premises: [wrongLink] }));
    assert.equal(scoped.code, 1);
    assert.deepEqual(scoped.report.counts, { killed: 0, survived: 2, timedOut: 0 });

    const suite = await mutate(project({ testCommand: SUITE_COMMAND, premises: [wrongLink] }));
    assert.equal(suite.code, 0);
    assert.equal(suite.report.selection, 'suite');
    assert.deepEqual(suite.report.counts, { killed: 2, survived: 0, timedOut: 0 });
  });

  test('warns about linked tests the baseline run never names', async () => {
    const dir = project({
      tests: `${header}// payment-schedule-exact is only mentioned here.\n${capTest}`,
      premises: [paymentPremise({ tests: ['payment-schedule-exact'] })],
    });
    const { code, report } = await mutate(dir);
    assert.equal(code, 1, 'no test ran, so every mutant survives');
    assert.deepEqual(report.premises[0].baseline.testsNotSeen, ['payment-schedule-exact']);
    assert.equal(report.counts.survived, 4);
  });

  test('a stale, ambiguous, or valueless target is invalid and exits 1', async () => {
    const dir = project({
      premises: [capPremise({
        mutants: [
          { file: 'src/retry.mjs', find: 'MAX_RETRIES = 4' },
          { file: 'src/retry.mjs', find: 'MAX_RETRIES' },
          { file: 'src/retry.mjs', find: 'export function shouldRetry' },
          { file: 'src/gone.mjs', find: '3' },
          { file: 'src', find: '3' },
          { file: 'src/retry.mjs', find: 'MAX_RETRIES = 3' },
        ],
      })],
    });
    const { code, report } = await mutate(dir);
    assert.equal(code, 1);
    assert.deepEqual(report.invalidMutants.map((m) => [m.file, m.reason]), [
      ['src/retry.mjs', 'find text not found'],
      ['src/retry.mjs', 'find text found more than once'],
      ['src/retry.mjs', 'no value to mutate'],
      ['src/gone.mjs', 'file not found'],
      ['src', 'not a file'],
    ]);
    assert.deepEqual(report.counts, { killed: 2, survived: 0, timedOut: 0 }, 'the valid target still runs');
  });

  test('linked tests that fail before any mutation exit 2 and run no mutant', async () => {
    const broken = `test('${PAYMENT}', () => {\n  assert.deepEqual(SCHEDULE.payment, [1, 2]);\n});\n`;
    const dir = project({ tests: header + capTest + broken, premises: [paymentPremise(), capPremise()] });
    const { code, report } = await mutate(dir);
    assert.equal(code, 2);
    assert.equal(report.ok, false);
    assert.match(report.error, /fail before any mutation for payment-schedule$/);
    const payment = report.premises.find((p) => p.id === 'payment-schedule');
    assert.notEqual(payment.baseline.exitCode, 0);
    assert.match(payment.baseline.output, /payment-schedule/);
    assert.deepEqual(payment.mutants, []);
    assert.deepEqual(report.counts, { killed: 3, survived: 0, timedOut: 0 }, 'other premises still run');
  });

  test('a test command that cannot start is a failing baseline', async () => {
    const dir = project({ testCommand: [join(tempDir(), 'no-such-runner')], premises: [capPremise()] });
    const { code, report } = await mutate(dir);
    assert.equal(code, 2);
    assert.match(report.premises[0].baseline.output, /ENOENT/);
  });

  test('a mutant that hangs the tests times out, counts as caught, and is listed separately', async () => {
    const count = 'export function count(n) {\n  let i = 0;\n  while (i < n) i += 1;\n  return i;\n}\n';
    const tests = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { count } from '../src/count.mjs';\ntest('count: counts to three', () => assert.equal(count(3), 3));\n";
    const dir = project({
      tests,
      files: { 'src/count.mjs': count },
      premises: [premise({ id: 'count', ...source, tests: ['count: counts to three'], mutants: [{ file: 'src/count.mjs', find: 'i += 1' }] })],
    });
    const { code, report } = await mutate(dir, { minTimeoutMs: 1500 });
    assert.equal(code, 0);
    assert.deepEqual(report.counts, { killed: 1, survived: 0, timedOut: 1 });
    assert.deepEqual(report.premises[0].mutants.map((m) => [m.to, m.result]), [['2', 'killed'], ['0', 'timedOut']]);
  });

  test('lists pinned premises without mutants, and skips mutants on premises no test pins yet', async () => {
    const dir = project({
      premises: [
        capPremise({ mutants: undefined }),
        paymentPremise({ tests: [] }),
        premise({ id: 'c', ...source, verdict: 'contradicted' }),
      ],
    });
    const { code, report } = await mutate(dir);
    assert.equal(code, 0);
    assert.deepEqual(report.noMutants, ['retry-cap']);
    assert.deepEqual(report.unpinned, ['payment-schedule']);
    assert.deepEqual(report.premises, []);
  });

  test('a ledger without testCommand exits 2', async () => {
    const dir = fixture({ premises: [capPremise()] });
    const r = cli('mutate', dir);
    assert.equal(r.code, 2);
    assert.match(r.report.error, /no "testCommand"/);
  });

  test('refuses to write through a symbolic link to a file outside the copy', async () => {
    const outside = join(tempDir(), 'retry.mjs');
    writeFileSync(outside, RETRY);
    const dir = project({ premises: [capPremise({ mutants: [{ file: 'src/linked.mjs', find: 'MAX_RETRIES = 3' }] })] });
    symlinkSync(outside, join(dir, 'src', 'linked.mjs'));
    const { code, report } = await mutate(dir);
    assert.equal(code, 2);
    assert.match(report.error, /refusing to mutate src\/linked\.mjs through a symbolic link/);
    assert.equal(readFileSync(outside, 'utf8'), RETRY);
  });

  test('runs from the command line and writes progress to stderr', () => {
    const dir = project({ premises: [capPremise()] });
    const r = cli('mutate', dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.report.counts, { killed: 3, survived: 0, timedOut: 0 });
    assert.equal(r.stderr.trim().split('\n').length, 3);
  });
});
