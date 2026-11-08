# Contributing

Thanks for your interest in verifiable-premises.
Bug reports, documentation fixes, and pull requests are welcome.

## Report a bug or ask for a feature

Open an [issue](https://github.com/bennyjo/verifiable-premises/issues/new/choose) and pick the bug report or feature request form.
For a bug, include the smallest `premises.json` and source files that reproduce it, the command you ran, and the JSON report you got.

Don't report security vulnerabilities in public issues.
Follow [`SECURITY.md`](SECURITY.md) instead.

## Set up

You need Node.js 22.17 or later and `git`.

```sh
git clone https://github.com/bennyjo/verifiable-premises.git
cd verifiable-premises
npm ci
```

`npm ci` installs only the lint tooling.
The checker and its tests use the Node.js standard library alone.

## Make a change

1. Fork the repository and create a branch from `main`.
1. Make your change, and add or update tests in [`test/`](test/) for any change in behavior.
   The `test` script in `package.json` names each test file, so add a new file there too.
1. Run the tests and the linter:

   ```sh
   npm test
   npm run lint
   ```

1. Update [`README.md`](README.md) and [`SKILL.md`](SKILL.md) when the change affects how people use the checker or the ledger.
1. Open a pull request against `main` and fill in the template.

CI runs the same tests and linter on every pull request, and a pull request is merged only after CI passes.

## Project rules

- **Keep the checker dependency-free.**
  `bin/premises.mjs` uses only the Node.js standard library, so it runs from a clone with nothing installed.
  Development tooling can be a `devDependency`.
- **Keep the tests offline.**
  Tests use local files, a temporary git repository, and a local HTTP server on `127.0.0.1`, never the network.
- **Keep the schema and the validator in step.**
  `schema/premises.schema.json` and `validate()` in `bin/premises.mjs` describe the same ledger.
  Change both together; the `schema and validator agree` tests check that they match.
- **Keep the examples passing.**
  `node bin/premises.mjs check examples/webhook-retries` must exit 0.

## Pull request titles

Start the title with a [Conventional Commits](https://www.conventionalcommits.org/) type, such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.
Pull requests are squash-merged, so the title becomes the commit message on `main`.

## Code of conduct

Everyone who takes part in this project agrees to follow the [code of conduct](CODE_OF_CONDUCT.md).
