# issueformlint

Catch broken GitHub issue templates before they reach your default branch.

issueformlint is a small, offline CLI for the files in .github/ISSUE_TEMPLATE. It checks YAML issue forms, Markdown issue template frontmatter, and config.yml. Errors include file, line, column, and a short explanation.

~~~text
.github/ISSUE_TEMPLATE/bug.yml:13:7 [invalid-default] Default must be a zero-based index within options.
~~~

## Why

A valid YAML file can still be an invalid GitHub issue form. For example, unquoted yes/no values are booleans under YAML 1.1, and dropdown options must be strings. GitHub documents this and other common form validation errors. Running issueformlint locally or in CI gives maintainers a faster feedback loop.

The project follows GitHub's published [issue form syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms), [form element schema](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema), and [common validation errors](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/common-validation-errors-when-creating-issue-forms).

## Quick start

Requires Node.js 20 or newer. Run the CLI from GitHub without cloning:

~~~sh
npm exec --yes --package=github:edwei06/issueformlint -- issueformlint .
~~~

## Try it from this checkout

~~~sh
npm install
node bin/issueformlint.js .
node bin/issueformlint.js /path/to/another/repo
node bin/issueformlint.js .github/ISSUE_TEMPLATE/bug.yml
~~~

Once the package is published to npm, the intended one-command use is:

~~~sh
npx issueformlint@latest .
~~~

The default path is the current repository. A directory argument can be a repository root or its ISSUE_TEMPLATE directory. The linter reads only files directly inside that template directory and does not access the network.

## Output for CI

~~~sh
node bin/issueformlint.js . --format github
node bin/issueformlint.js . --format json
~~~

The github format emits GitHub Actions error annotations. The json format contains filesChecked and diagnostics with file, line, column, path, code, and message. Exit codes are 0 for a clean check, 1 for validation errors, and 2 for an invalid invocation or unreadable input.

## What it checks

- Required form keys and all six documented element types: markdown, input, textarea, dropdown, checkboxes, and upload.
- Field types, unknown keys, duplicate IDs, labels that resolve to the same field reference, duplicate options, and invalid dropdown defaults.
- Form names repeated across YAML and Markdown templates in the same directory.
- YAML 1.1 values such as unquoted yes/no that GitHub interprets as booleans.
- Markdown template frontmatter name/about and chooser config contact links.

This is an independent preflight checker, not GitHub's internal validator. GitHub's form schema is in public preview and may change. The first release does not check whether referenced labels, assignees, issue types, or projects exist in a repository.

## Development

~~~sh
npm ci
npm test
npm run check
npm run selftest
~~~

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance. Licensed under MIT.
