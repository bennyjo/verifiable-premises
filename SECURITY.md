# Security policy

## Supported versions

verifiable-premises has no releases yet.
Security fixes go to the `main` branch only.

## Report a vulnerability

Report vulnerabilities privately through GitHub:

1. Go to the repository's [**Security** tab](https://github.com/bennyjo/verifiable-premises/security).
1. Click **Report a vulnerability**.
1. Describe the problem, the affected commit, and the steps to reproduce it.

If **Report a vulnerability** isn't available, email the maintainer, [bennyjo](https://github.com/bennyjo), at the address on their GitHub profile.

Don't open a public issue, pull request, or discussion about a vulnerability before it's fixed.
The maintainer replies in the private advisory, works on a fix there, and credits you when the advisory is published unless you ask not to be named.

## Trust model

The checker treats a `premises.json` ledger as trusted input, like a build file.
When you run `premises check`, it does the following:

- Fetches every `http://` and `https://` source in the ledger, and follows redirects.
- Reads every local source and snapshot path, including absolute paths.
- Reads every file that the `testFiles` globs match, including absolute paths and `../` patterns.
- Runs `git show --end-of-options <ref>:<path>` for every `git:` source. It runs `git` directly, without a shell, and a ref can't be read as an option.
- Writes HTTP responses under `.premises/captures/` next to the ledger. It exits 2 rather than write through a symbolic link at `.premises`, `captures`, or a capture file.

Apart from `git show`, `premises check` runs no command.

`premises mutate` is a separate command because it runs code.
When you run it, it does the following:

- Copies the ledger's directory, without `.git` and `.premises`, to a new temporary directory, and deletes the copy when it's done.
- Runs the ledger's `testCommand` in the copy, without a shell, once for the baseline and once for each mutant. That command can do anything your test suite can, as `npm test` can.
- Changes only the `mutants` files inside the copy. A `file` must be a relative path without `..`, and the command exits 2 rather than write through a symbolic link that leads out of the copy.

Review a ledger from someone else before you check it, as you would a script, and never run `premises mutate` on a ledger you don't trust.
A way to make the checker do more than these lists, for example make `premises check` run a shell command or write outside `.premises/captures/`, or make `premises mutate` itself write outside the temporary copy, is a vulnerability worth reporting.
