#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { lintPath } from '../src/lint.js';

const usage = [
  'issueformlint [repository | ISSUE_TEMPLATE directory | file] [--format text|json|github]',
  '',
  'Check GitHub issue forms, Markdown issue templates, and config.yml.',
  'Defaults to the current repository.',
  '',
  'Options:',
  '  --format VALUE   text (default), json, or github annotations',
  '  --help           Show this help',
  '  --version        Show the version',
].join('\n');

function fail(message) {
  process.stderr.write('issueformlint: ' + message + '\n');
  process.exitCode = 2;
}

function displayPath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/') || path.basename(file);
}

function escapeWorkflow(value, property = false) {
  let escaped = String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  if (property) escaped = escaped.replaceAll(':', '%3A').replaceAll(',', '%2C');
  return escaped;
}

function parseArgs(argv) {
  let target = '.';
  let format = 'text';
  let targetSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { action: 'help' };
    if (arg === '--version' || arg === '-v') return { action: 'version' };
    if (arg === '--format') {
      format = argv[++index];
      if (!format) throw new Error('--format needs a value.');
    } else if (arg.startsWith('--format=')) {
      format = arg.slice('--format='.length);
    } else if (arg.startsWith('-')) {
      throw new Error('Unknown option: ' + arg);
    } else if (targetSeen) {
      throw new Error('Provide only one path.');
    } else {
      target = arg;
      targetSeen = true;
    }
  }
  if (!['text', 'json', 'github'].includes(format)) throw new Error('Unknown format: ' + format);
  return { action: 'lint', target, format };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === 'help') {
    process.stdout.write(usage + '\n');
  } else if (options.action === 'version') {
    const packageFile = new URL('../package.json', import.meta.url);
    process.stdout.write(JSON.parse(fs.readFileSync(packageFile, 'utf8')).version + '\n');
  } else {
    const result = lintPath(options.target);
    const diagnostics = result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      file: displayPath(diagnostic.file),
    }));
    if (options.format === 'json') {
      process.stdout.write(JSON.stringify({ filesChecked: result.files.length, diagnostics }, null, 2) + '\n');
    } else if (options.format === 'github') {
      for (const diagnostic of diagnostics) {
        process.stdout.write('::error file=' + escapeWorkflow(diagnostic.file, true) +
          ',line=' + diagnostic.line + ',col=' + diagnostic.column +
          ',title=' + escapeWorkflow(diagnostic.code, true) + '::' +
          escapeWorkflow(diagnostic.message) + '\n');
      }
    } else if (diagnostics.length > 0) {
      for (const diagnostic of diagnostics) {
        process.stderr.write(diagnostic.file + ':' + diagnostic.line + ':' + diagnostic.column +
          ' [' + diagnostic.code + '] ' + diagnostic.message + '\n');
      }
      process.stderr.write('Found ' + diagnostics.length + ' issue(s) in ' + result.files.length + ' file(s).\n');
    } else {
      process.stdout.write('OK: checked ' + result.files.length + ' issue template file(s).\n');
    }
    if (diagnostics.length > 0) process.exitCode = 1;
  }
} catch (error) {
  fail(error.message);
}
