# verifiable-premises

[![CI](https://github.com/bennyjo/verifiable-premises/actions/workflows/ci.yml/badge.svg)](https://github.com/bennyjo/verifiable-premises/actions/workflows/ci.yml)

Check every premise a task relies on against a quoted primary source, and link each test to the premise it pins.

One wrong premise about an outside system can be copied into the code, the tests, and the reviewer's brief, so every gate agrees with it.
A `premises.json` ledger records each premise with a verbatim quote from its primary source, and a script re-checks that the quote is still there and that every test link is valid.

## The problem

Tests and reviews check code against what the author believes about the outside world.
When that belief is wrong, every gate inherits the error:

1. A brief or contract restates a vendor limit, a spec rule, or a design decision, and gets it slightly wrong.
2. The code implements the wrong rule.
3. The tests assert the same wrong rule, so they pass.
4. The reviewer reads the same brief, so the change looks correct.

Nothing in that chain ever goes back to the primary source, so green tests and an approved review say nothing about whether the premise is true.
The same gap opens later when the source changes: the docs move on, but the tests keep pinning the old behavior.

Verifiable Premises closes the gap with a ledger that ties each premise to a verbatim quote from its primary source, and a checker that confirms each quote is still there and that each test pins only a premise the source supports.

## Who it's for

Developers and coding agents who write tests or code that depend on facts they didn't establish themselves: how an outside API behaves, a limit from vendor docs, a rule from a spec, or a decision recorded in a design report.
It's most useful when a contract, brief, or issue restates those facts second-hand.

## Where it fits in the development lifecycle

The ledger is written first and checked again at every later stage, by the same command.

```mermaid
flowchart LR
  A[Research and spec] --> B[Plan] --> C[Build and test] --> D[Review] --> E[CI] --> F[Maintenance]
  L[(premises.json)] -.-> A & B & C & D & E & F
```

| Stage | What Verifiable Premises does |
|---|---|
| Research and spec | You write `premises.json` before any code: one claim per fact, its primary source, and a verbatim quote. The checker confirms each quote is in its source, whether that's a local file, a file at a Git ref, or an `http(s)` page. A brief or contract that restates a claim goes in `paraphrasedIn`, and its quote is checked too, so you can see which documents repeat a fact second-hand. |
| Plan | Each premise gets a verdict: `supported`, `contradicted`, or `unsupported`. A `contradicted` premise quotes the passage that disproves it, so you fix the plan or brief before building on it. An `unsupported` premise is an open question, not a fact to build on. |
| Build and test | Each test that depends on a premise puts that premise's test ID in its name, and the ledger lists the same ID. The checker fails when a listed test ID appears in no file that the ledger's `testFiles` globs match, or when a test pins a premise that is `contradicted` or `unsupported`. It lists supported premises that no test pins yet under `unpinned`. |
| Review | You attach the checker's JSON report to the PR or the reviewer's brief. The reviewer sees each claim with its source and quote, the counts per verdict, and which premises are still unpinned, instead of trusting the brief's restatement. For `http(s)` sources, the report lists the stored captures and any fallback to a saved snapshot, so the reviewer knows whether the evidence came from the live page. |
| CI | Run `premises check` as a step. It exits 1 when a quote is missing or changed or a test link is invalid, and 2 when the ledger is malformed, so the build fails without parsing the report. This repository doesn't ship a ready-made CI action. |
| Maintenance | Rerunning the check shows when a source no longer says what the ledger quotes: an edited local file, a moved branch for a `git:` source, or a changed web page. The report lists the tests that pin each premise, so you know which tests to revisit. A premise whose page is rendered by JavaScript can fall back to a saved snapshot, but only when its digest still matches, and the report lists every fallback. |

## Status

Early and unreleased, at version 0.1.0.

- There are no tagged releases, and the package isn't published to npm.
- The ledger schema and the JSON report can still change between commits.
- The checker has one command, `check`.

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
The checker writes nothing else.

## Usage

```sh
node bin/premises.mjs check [path]
```

`path` is a `premises.json` file or a directory that holds one, and defaults to `./premises.json`.

| Exit code | Meaning |
|---|---|
| `0` | Every quote was found, and every test link is valid. |
| `1` | A quote is missing or changed, a listed test doesn't exist, or a test pins a premise that is contradicted or unsupported. |
| `2` | Usage or input error: bad arguments, a `premises.json` that can't be read or doesn't match the schema, or a symbolic link in the path of an HTTP capture. |

The checker prints a JSON report with counts per verdict, missing quotes, unpinned premises, unknown tests, pinned premises that aren't supported, snapshot fallbacks, and stored HTTP captures.
See [`SKILL.md`](SKILL.md) for each field, the source forms, and the test link rule.

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
