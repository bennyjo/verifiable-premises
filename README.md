# verifiable-premises

[![CI](https://github.com/bennyjo/verifiable-premises/actions/workflows/ci.yml/badge.svg)](https://github.com/bennyjo/verifiable-premises/actions/workflows/ci.yml)

Check every premise a task relies on against a quoted primary source, and link each test to the premise it pins.

One wrong premise about an outside system can be copied into the code, the tests, and the reviewer's brief, so every gate agrees with it.
A `premises.json` ledger records each premise with a verbatim quote from its primary source, and a script re-checks that the quote is still there and that every test link is valid.
A second command changes the code that encodes each premise and checks that the premise's linked tests fail, so a test that only looks like it pins a premise is caught.

## Who it's for

Developers and coding agents who write tests or code that depend on facts they didn't establish themselves: how an outside API behaves, a limit from vendor docs, a rule from a spec, or a decision recorded in a design report.
It's most useful when a contract, brief, or issue restates those facts second-hand.

## Status

Early and unreleased, at version 0.1.0.

- There are no tagged releases, and the package isn't published to npm.
- The ledger schema and the JSON report can still change between commits.
- The checker has two commands: `check` and `mutate`.

## Contents

- [`SKILL.md`](SKILL.md): the agent skill. It covers when to use the ledger, how to write it before tests or code, and how to run the checker.
- [`schema/premises.schema.json`](schema/premises.schema.json): the JSON Schema for `premises.json`.
- [`bin/premises.mjs`](bin/premises.mjs): the checker, one dependency-free Node script.
- [`test/`](test/): the checker's tests. They use local files, a temporary git repository, and a local HTTP server, never the network.
- [`examples/webhook-retries/`](examples/webhook-retries/): a ledger for a made-up task, with the excerpts of its two made-up sources.

## Requirements

Node.js 22.17 or later. The checker uses only the standard library: `fetch` for HTTP and `fs.globSync` for test files.
Git sources also need Git 2.24 or later on the `PATH`.

## Install

The checker isn't on npm yet, so run it from a clone:

```sh
git clone https://github.com/bennyjo/verifiable-premises.git
cd verifiable-premises
```

The checker has no runtime dependencies, so there's nothing to install before you run it.
To run it as `premises check` from any directory, link the package with `npm link`.

To use the agent skill, install [`SKILL.md`](SKILL.md) wherever your agent loads skills from.
The skill runs the checker from this repository.

## Quick start

From the root of your clone, write a source and a ledger that quotes it:

```sh
mkdir demo
printf 'Each API key can send 60 requests per minute.\n' > demo/limits.md
cat > demo/premises.json <<'EOF'
{
  "premises": [
    {
      "id": "rate-limit-per-key",
      "claim": "The API accepts at most 60 requests a minute from one key.",
      "source": "limits.md",
      "quote": "Each API key can send 60 requests per minute.",
      "retrieved": "2026-11-03",
      "verdict": "supported",
      "tests": []
    }
  ]
}
EOF
node bin/premises.mjs check demo
```

The check exits 0 and lists `rate-limit-per-key` under `unpinned`, because no test pins it yet.
Change `60` to `100` in `demo/limits.md` and run the check again: it exits 1 and reports the quote under `missingQuotes`.

## For coding agents

Coding agents are the main users of this tool.
Every command below is non-interactive: the checker never prompts, needs no install, and uses the network only to fetch a ledger's `http://` and `https://` sources.
`premises mutate` also runs the ledger's `testCommand`, so the tests it runs can do whatever your test suite does.

### From clone to a verified run

```sh
git clone https://github.com/bennyjo/verifiable-premises.git
cd verifiable-premises
node --version   # needs v22.17.0 or later
git --version    # needs 2.24 or later
npm test
set -o pipefail
node bin/premises.mjs check examples/webhook-retries \
  | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const r = JSON.parse(s); console.log(JSON.stringify(r.counts)); process.exit(r.ok ? 0 : 1); })'
```

The run works when every command exits 0 and the last one prints `{"supported":5,"contradicted":3,"unsupported":0}`.
Check the exit code of `npm test`, not its output: the test report's format differs between Node.js versions.

To write ledgers and tests that use the checker, follow [`SKILL.md`](SKILL.md).
A ledger can set `"$schema"` to `schema/premises.schema.json` so an editor or a JSON Schema validator checks it before you run the checker.

### Output

`premises check` writes to stdout and stderr as follows:

- **Report:** with exit code 0 or 1, stdout holds one JSON object, described in the next table.
- **Input error:** with exit code 2, stdout holds `{"ok": false, "error": "<message>"}`. This covers a ledger that can't be read, isn't valid JSON, or doesn't match the schema, and a symbolic link in the path of an HTTP capture.
- **Usage error:** with exit code 2, the usage text goes to stderr and stdout is empty. This covers a missing command, an unknown option, or an extra argument.
- **Internal error:** with exit code 2, a stack trace goes to stderr.

`node bin/premises.mjs --help` prints the usage text to stdout and exits 0.
There's no `--version` option.

| Report field | Contents |
|---|---|
| `ok` | `true` when the exit code is 0. |
| `ledger` | The ledger path, as given or with `premises.json` appended to a directory. |
| `counts` | `{"supported": n, "contradicted": n, "unsupported": n}`. |
| `missingQuotes` | `[{id, where, source, quote, reason}]`, where `where` is `quote` or `paraphrasedIn[<index>]`. |
| `unpinned` | IDs of supported premises that no test pins. They don't fail the check. |
| `unknownTests` | `[{id, test}]` for test IDs that no matched test file contains. |
| `pinnedNotSupported` | `[{id, verdict, tests}]` for premises that tests pin although they aren't supported. |
| `snapshotFallbacks` | `[{id, source, snapshot, sha256, reason}]` for quotes found only in a stored snapshot. |
| `captures` | `[{source, command, path, sha256}]` for each HTTP response stored under `.premises/captures/`. |
| `testFiles` | The files that the ledger's `testFiles` globs matched, relative to the ledger. |
| `premises` | `[{id, verdict, claim, source, quoteFound, paraphrasedIn, note, tests}]`, one entry per premise. `source` and `quoteFound` are `null` for a premise without a source. `paraphrasedIn` (`[{source, quoteFound}]`) and `note` appear only when the ledger sets them. |

A check with an `http://` or `https://` source writes the response under `.premises/captures/` next to the ledger.
`premises mutate` works in a temporary copy of the ledger's directory and deletes it when it's done.
The checker writes nothing else.

## Usage

```sh
node bin/premises.mjs check [path]
node bin/premises.mjs mutate [path]
```

`path` is a `premises.json` file or a directory that holds one, and defaults to `./premises.json`.

### `premises check`

| Exit code | Meaning |
|---|---|
| `0` | Every quote was found, and every test link is valid. |
| `1` | A quote is missing or changed, a listed test doesn't exist, or a test pins a premise that is contradicted or unsupported. |
| `2` | Usage or input error: bad arguments, a `premises.json` that can't be read or doesn't match the schema, or a symbolic link in the path of an HTTP capture. |

The checker prints a JSON report with counts per verdict, missing quotes, unpinned premises, unknown tests, pinned premises that aren't supported, snapshot fallbacks, and stored HTTP captures.
See [`SKILL.md`](SKILL.md) for each field, the source forms, and the test link rule.

### `premises mutate`

A test can link to a premise and pass without pinning it: it might check the length of a retry schedule but not its delays.
`premises mutate` finds such tests.
Each premise lists, in `mutants`, the code that encodes it, and the ledger sets the command that runs the tests:

```json
{
  "testFiles": ["test/*.test.mjs"],
  "testCommand": ["node", "--test", "--test-name-pattern", "{pattern}", "test/*.test.mjs"],
  "premises": [
    {
      "id": "disable-threshold",
      "tests": ["disable-threshold: disables after 20 failures over 6 hours"],
      "mutants": [
        { "file": "src/retry.mjs", "find": "consecutiveFailures >= 20 && failingForMs >= 6 * HOUR" }
      ]
    }
  ]
}
```

The other premise fields are left out of this example.
For each supported premise that has both `tests` and `mutants`, the command does the following:

1. Copies the ledger's directory, without `.git` and `.premises`, to a temporary directory. Your files are never changed.
1. Runs `testCommand` in the copy, with each `{pattern}` replaced by a regular expression that matches the premise's test IDs. This is the baseline, and it must pass.
1. Makes one mutant for each value in each `find` text, and runs the same command again for each mutant.
   A mutant is killed when the command exits non-zero, and survives when it exits 0.

| Value in `find` | Mutants |
|---|---|
| A decimal number, such as `3`, `60_000`, or `0.5` | One more, and one less unless the number is 0 |
| `<`, `<=`, `>`, or `>=` | `<` and `<=` swap, and so do `>` and `>=` |
| `==`, `!=`, `===`, or `!==` | Negated |
| `true`, `false`, `True`, or `False` | Flipped |
| A quoted string, such as `'payment'` | `-mutant` added inside the quotes |

`file` is relative to the ledger and must stay inside its directory.
`find` is exact text that must occur once in that file, so a target that a refactor moved shows up as invalid instead of passing.
Only `supported` premises can have `mutants`.

`testCommand` runs without a shell.
Without `{pattern}`, every mutant runs the whole command and the report says `"selection": "suite"`.
Then a mutant that an unrelated test catches counts as killed, which says nothing about the premise's own tests.
A mutant that runs longer than 10 seconds, or three times the baseline if that's longer, is stopped and counted as killed, because it changed the behavior.

| Exit code | Meaning |
|---|---|
| `0` | Every mutant was killed. |
| `1` | A mutant survived, or a `mutants` target is invalid. |
| `2` | Usage or input error, including a ledger without `testCommand`, a `mutants` target reached through a symbolic link, or linked tests that fail before any mutation. |

While it runs, the command writes one line per mutant to stderr:

```text
disable-threshold  src/retry.mjs:11  >= -> >  survived  93ms
```

With exit code 0 or 1, stdout holds one JSON object.
When linked tests fail before any mutation, stdout holds the same object with an `error` field and the exit code is 2.
Other errors print `{"ok": false, "error": "<message>"}`, as `premises check` does.

| Report field | Contents |
|---|---|
| `ok` | `true` when the exit code is 0. |
| `error` | Present only with exit code 2: which premises' linked tests fail before any mutation. |
| `ledger` | The ledger path, as given or with `premises.json` appended to a directory. |
| `selection` | `pattern` when `testCommand` has `{pattern}`, otherwise `suite`. |
| `counts` | `{"killed": n, "survived": n, "timedOut": n}`. Timed-out mutants count as caught. |
| `survived` | `[{id, file, line, kind, from, to, mutated}]`, where `mutated` is the `find` text with the change. Strengthen the linked tests until each one is killed. |
| `invalidMutants` | `[{id, file, find, reason}]` for a target whose file is missing, whose `find` text is not found or found more than once, or that has no value to mutate. |
| `noMutants` | IDs of supported premises that tests pin but that have no `mutants`. They don't fail the run. |
| `unpinned` | IDs of supported premises with `mutants` but no `tests` yet. They are skipped and don't fail the run. |
| `premises` | `[{id, tests, baseline, mutants}]` for each premise that ran. `baseline` is `{exitCode, ms, testsNotSeen}`, plus the end of the output in `output` when it failed. `mutants` is `[{file, line, kind, from, to, result, ms}]`, and `result` is `killed`, `survived`, or `timedOut`. |

`testsNotSeen` lists linked test IDs that the baseline output never names.
Node.js exits 0 when `--test-name-pattern` matches no test, so every mutant of such a premise survives; this list tells you why.
It's a warning, not a failure, because some test runners don't print test names.

An equivalent mutant is one that no correct test can catch, such as a number in a comment.
To leave it out, shorten `find` so it doesn't include that value, and say why in the premise's `note`.

## Example: webhook retries

This example is made up: the task and both of its sources were written to show how a ledger works.
The phase 1 contract for a webhook service's retry rules says that "each delivery retries on its family's schedule, whose delays and disable threshold are starting points to tune in production".
The design report it came from also fixes at most three retries per delivery, which the contract's paraphrase leaves out.

```sh
node bin/premises.mjs check examples/webhook-retries
```

The ledger was written before any test exists.
It shows that the retry rule's source is the design report and that the contract only paraphrases it.
It also marks three of the contract's retry rules as contradicted by the report: a 10-second Payment retry, a separate timeout class for Order, and retrying `410 Gone` for Account.
The check exits 0 and lists every supported premise as unpinned, because no test pins it yet.

## Development

```sh
npm test            # run the tests; needs no install
npm ci              # install the lint tooling
npm run lint        # run ESLint
```

CI runs both on every push to `main` and on every pull request.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).
Everyone who takes part agrees to follow the [code of conduct](CODE_OF_CONDUCT.md).
To report a security vulnerability, follow [`SECURITY.md`](SECURITY.md) instead of opening an issue.

## License

This project is available under the [Apache License 2.0](LICENSE).
