import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { lintPath, lintSource } from '../src/lint.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'issueformlint.js');

function codeSet(source, kind = 'form') {
  return new Set(lintSource(source, 'sample.yml', kind).diagnostics.map((item) => item.code));
}

function tempRepository() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'issueformlint-'));
  const templates = path.join(repository, '.github', 'ISSUE_TEMPLATE');
  fs.mkdirSync(templates, { recursive: true });
  return { repository, templates };
}

const validForm = [
  'name: Bug report',
  'description: Report a reproducible bug.',
  'title: "[Bug] "',
  'labels: [bug, triage]',
  'body:',
  '  - type: markdown',
  '    attributes:',
  '      value: Thank you for reporting.',
  '  - type: input',
  '    id: version',
  '    attributes:',
  '      label: Version',
  '    validations:',
  '      required: true',
  '  - type: textarea',
  '    id: details',
  '    attributes:',
  '      label: Details',
  '      render: shell',
  '  - type: dropdown',
  '    id: platform',
  '    attributes:',
  '      label: Platform',
  '      options: [Windows, macOS, Linux]',
  '      default: 0',
  '  - type: checkboxes',
  '    id: confirmation',
  '    attributes:',
  '      label: Checklist',
  '      options:',
  '        - label: I searched existing issues',
  '          required: true',
  '  - type: upload',
  '    id: logs',
  '    attributes:',
  '      label: Upload logs',
  '    validations:',
  '      accept: ".log,.txt"',
].join('\n') + '\n';

test('accepts each documented issue form element type', () => {
  assert.deepEqual(lintSource(validForm, 'sample.yml').diagnostics, []);
});

test('reports YAML syntax and duplicate mapping keys', () => {
  assert.ok(codeSet('name: Bug\nname: Again\n').has('yaml-error'));
  assert.ok(codeSet('name: [oops\n').has('yaml-error'));
});

test('catches common schema mistakes with source positions', () => {
  const source = [
    'name: Bug',
    'description: Report a bug',
    'extra: no',
    'body:',
    '  - type: markdown',
    '    id: illegal',
    '    attributes:',
    '      value: Hello',
    '  - type: dropdown',
    '    id: bad id',
    '    attributes:',
    '      label: Version',
    '      options: [One, One, None]',
    '      default: 5',
  ].join('\n');
  const diagnostics = lintSource(source, 'sample.yml').diagnostics;
  const codes = new Set(diagnostics.map((item) => item.code));
  for (const code of ['unknown-key', 'forbidden-key', 'invalid-id', 'duplicate-option', 'reserved-option', 'invalid-default']) {
    assert.ok(codes.has(code), code);
  }
  assert.ok(diagnostics.every((item) => item.line >= 1 && item.column >= 1));
  assert.equal(diagnostics.find((item) => item.code === 'invalid-id').line, 10);
});

test('treats unquoted YAML 1.1 yes/no options as invalid booleans', () => {
  const source = 'name: Bug\ndescription: Report\nbody:\n  - type: dropdown\n    attributes:\n      label: Choice\n      options: [yes, no]\n';
  const invalidStrings = lintSource(source, 'sample.yml').diagnostics.filter((item) => item.code === 'invalid-string');
  assert.equal(invalidStrings.length, 2);
});

test('allows repeated labels when one field has a distinct id', () => {
  const source = 'name: Bug\ndescription: Report\nbody:\n  - type: input\n    attributes:\n      label: Details\n  - type: textarea\n    id: more-details\n    attributes:\n      label: Details\n';
  assert.deepEqual(lintSource(source, 'sample.yml').diagnostics, []);
});

test('validates chooser config and Markdown template frontmatter', () => {
  assert.deepEqual(lintSource(
    'blank_issues_enabled: false\ncontact_links:\n  - name: Discussions\n    url: https://github.com/org/repo/discussions\n    about: Ask questions here.\n',
    'config.yml', 'config').diagnostics, []);
  assert.ok(codeSet('contact_links:\n  - name: Help\n    url: local/path\n    about: Help\n', 'config').has('invalid-url'));
  assert.deepEqual(lintSource('---\nname: Question\nabout: Ask a question\n---\nHello\n', 'question.md', 'markdown').diagnostics, []);
  assert.ok(codeSet('Hello\n', 'markdown').has('missing-frontmatter'));
});

test('checks a repository and emits machine-readable CLI diagnostics', () => {
  const { repository, templates } = tempRepository();
  fs.writeFileSync(path.join(templates, 'bug.yml'), validForm);
  fs.writeFileSync(path.join(templates, 'old.md'), '---\nname: Bug report\nabout: Old template\n---\n');
  fs.writeFileSync(path.join(templates, 'config.yml'), 'blank_issues_enabled: false\n');
  const result = lintPath(repository);
  assert.equal(result.files.length, 3);
  assert.ok(result.diagnostics.some((item) => item.code === 'duplicate-template-name'));

  const jsonRun = spawnSync(process.execPath, [cli, repository, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(jsonRun.status, 1);
  const output = JSON.parse(jsonRun.stdout);
  assert.equal(output.filesChecked, 3);
  assert.ok(output.diagnostics.some((item) => item.code === 'duplicate-template-name'));

  const githubRun = spawnSync(process.execPath, [cli, repository, '--format', 'github'], { encoding: 'utf8' });
  assert.equal(githubRun.status, 1);
  assert.match(githubRun.stdout, /::error file=.*title=duplicate-template-name::/);
});

test('returns success on a clean repository and an input error on missing templates', () => {
  const { repository, templates } = tempRepository();
  fs.writeFileSync(path.join(templates, 'bug.yml'), validForm);
  const goodRun = spawnSync(process.execPath, [cli, repository], { encoding: 'utf8' });
  assert.equal(goodRun.status, 0);
  assert.match(goodRun.stdout, /OK: checked 1 issue template file/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'issueformlint-empty-'));
  const badRun = spawnSync(process.execPath, [cli, empty], { encoding: 'utf8' });
  assert.equal(badRun.status, 2);
  assert.match(badRun.stderr, /No .github\/ISSUE_TEMPLATE directory/);
});

test('finds checkbox labels that collide with other fields', () => {
  const source = 'name: Bug\ndescription: Report\nbody:\n  - type: input\n    attributes:\n      label: Name\n  - type: checkboxes\n    attributes:\n      label: Checklist\n      options:\n        - label: Name\n        - label: Name\n';
  const diagnostics = lintSource(source, 'sample.yml').diagnostics.filter((item) => item.code === 'duplicate-label');
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((item) => item.message.includes('same field reference')));
});

test('detects labels that GitHub parameterizes to the same reference', () => {
  const bad = 'name: Bug\ndescription: Report\nbody:\n  - type: input\n    attributes:\n      label: Name?\n  - type: textarea\n    id: name\n    attributes:\n      label: Name???????\n';
  const good = bad.replace('id: name\n', 'id: your-name\n');
  assert.ok(codeSet(bad).has('duplicate-label'));
  assert.deepEqual(lintSource(good, 'sample.yml').diagnostics, []);
});

test('accepts empty optional lists', () => {
  const source = 'name: Bug\ndescription: Report\nlabels: []\nassignees: []\nprojects: []\nbody:\n  - type: input\n    attributes:\n      label: Version\n';
  assert.deepEqual(lintSource(source, 'sample.yml').diagnostics, []);
});

test('flags unsupported .yaml template filenames', () => {
  const { repository, templates } = tempRepository();
  fs.writeFileSync(path.join(templates, 'bug.yaml'), validForm);
  fs.writeFileSync(path.join(templates, 'config.yaml'), 'blank_issues_enabled: false\n');
  const result = lintPath(repository);
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.diagnostics.map((item) => item.code),
    ['unsupported-extension', 'unsupported-extension']);
  assert.ok(result.diagnostics.every((item) => item.line === 1 && item.column === 1));

  const run = spawnSync(process.execPath, [cli, repository], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /rename this file to \.yml/);
});
