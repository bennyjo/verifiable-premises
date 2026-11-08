---
name: verifiable-premises
description: Tie each premise a task relies on to a quoted primary source that a script re-checks, and link each test to the premise it pins. Use before writing tests or code that depend on facts about an outside system, an API, a spec, or a design decision, and whenever a brief or contract restates such facts.
---

# Verifiable premises

One wrong premise about an outside system gets copied into the code, the tests, the hidden checks, and the reviewer's brief, so every gate agrees with it.
This skill breaks that chain: write each premise down with a verbatim quote from its primary source, let a script confirm the quote is really there, and make every test name the premise it pins.

## When to use it

Use this skill when a task depends on a fact you didn't establish yourself, such as:

- How an outside API, library, file format, or protocol behaves.
- A limit, default, or rule from vendor docs or a spec.
- A product or design decision recorded in a report.
- Any fact a contract, brief, or issue states second-hand.

Skip it for facts the task's own code defines.

## Workflow

Write `premises.json` before you write tests or code.

1. **List the premises.**
   For each fact the task relies on, write one `claim` in your own words, with a short, stable `id` such as `rate-limit-per-key`.
2. **Find the primary source.**
   The primary source is the system itself, its official docs, or the decision record, not a document that restates it.
   A contract or brief that restates the claim goes in `paraphrasedIn`, never in `source`.
3. **Quote it verbatim.**
   Copy the passage exactly, markdown markers included.
   The checker normalizes whitespace only, so a quote can wrap across lines, but every other character must match.
   Set `retrieved` to the date you read it.
4. **Set the verdict** from what the source says:
   - `supported`: the source states the claim.
   - `contradicted`: the source says otherwise. Quote the passage that contradicts it, and fix the plan, contract, or brief that assumed it.
   - `unsupported`: no primary source states it. `source` and `quote` are optional. Treat the claim as an open question, not a fact.
5. **Run the checker** and fix every finding before you go on.
6. **Write tests that pin supported premises.**
   Put the premise's test ID string, such as `rate-limit-per-key: rejects the 61st request`, in the test's name, and list the same string in the premise's `tests`.
   Never pin a premise that is contradicted or unsupported.
7. **Run the checker again** before you hand off, and add its JSON report to the PR or the reviewer's brief.

### Example premise

```json
{
  "id": "retry-cap",
  "claim": "A delivery gets at most three retries, on the schedules the design report lists.",
  "source": "sources/design-report.md",
  "quote": "**One retry schedule per endpoint, and at most three retries per delivery.**",
  "retrieved": "2026-11-04",
  "verdict": "supported",
  "paraphrasedIn": [
    { "source": "sources/contract.md", "quote": "Each delivery retries on its family's schedule, whose delays and disable threshold are starting points to tune in production." }
  ],
  "tests": []
}
```

`schema/premises.schema.json` defines every field.
`examples/webhook-retries/premises.json` shows a full ledger for a made-up task, written before any test exists.

## Sources

`source` takes one of these forms:

- An `http://` or `https://` URL. The checker fetches it, reduces HTML to its visible text, and stores the response and the command that reproduces the fetch under `.premises/captures/` next to the ledger.
- A local path, relative to the `premises.json` file.
- `git:<ref>:<path>`, read with `git show <ref>:<path>` in the ledger's directory. The path is relative to the repository root.

Docs rendered by JavaScript defeat a plain fetch.
For such a page, save the rendered text, record it as `snapshot` with its SHA-256 digest (`shasum -a 256 <file>`), and set `"jsRendered": true` on the premise.
The checker falls back to the snapshot when the live fetch fails (a network error or a non-2xx status).
It also falls back when the page loads but doesn't show the quote, but only for a premise with `jsRendered`.
Without `jsRendered`, a page that loads without the quote is a missing quote and exits 1, so an edited upstream page can't hide behind an old snapshot.
Each fallback appears under `snapshotFallbacks` in the report, so a reviewer can see that the evidence is the stored copy, not the live page.

## Running the checker

```sh
node bin/premises.mjs check path/to/premises.json
```

Run from another project, `bin/premises.mjs` is not there, so use `premises check` after running `npm link` in a clone of this repository, or give the absolute path to `bin/premises.mjs` in that clone.

The path can be the ledger file or the directory that holds it, and it defaults to `./premises.json`.
The command prints a JSON report and exits with one of these codes:

| Exit code | Meaning |
|---|---|
| `0` | Every quote was found, and every test link is valid. |
| `1` | A quote is missing or changed, a listed test doesn't exist, or a test pins a premise that isn't `supported`. |
| `2` | Usage or input error: bad arguments, a `premises.json` that can't be read or doesn't match the schema, or a symbolic link in the path of an HTTP capture. |

Read these report fields:

- `counts`: premises per verdict.
- `missingQuotes`: quotes not found, with the reason. `where` says whether the premise's own quote or a `paraphrasedIn` quote failed.
- `unpinned`: supported premises that no test pins yet. They don't fail the check, but each one is a gap to close before review.
- `unknownTests`: listed test IDs that no test file contains.
- `pinnedNotSupported`: tests that pin a contradicted or unsupported premise.
- `snapshotFallbacks` and `captures`: where the evidence for http(s) sources came from.

A test ID resolves when its exact string appears anywhere in a file that a `testFiles` glob matches, with globs relative to the ledger.
Pick IDs that won't appear by accident, such as the premise ID plus a short description.
