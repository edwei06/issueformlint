import fs from 'node:fs';
import path from 'node:path';
import { LineCounter, parseDocument } from 'yaml';

const FORM_KEYS = new Set(['name', 'description', 'body', 'assignees', 'labels', 'title', 'type', 'projects']);
const ELEMENT_KEYS = new Set(['type', 'id', 'attributes', 'validations']);
const ELEMENT_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes', 'upload']);
const TEXT_KEYS = new Set(['label', 'description', 'placeholder', 'value']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function location(context, keyPath) {
  const parts = [...keyPath];
  let node;
  while (parts.length > 0 && !node) {
    try {
      node = context.document.getIn(parts, true);
    } catch {
      node = null;
    }
    if (!node) parts.pop();
  }
  node ??= context.document.contents;
  const position = context.lines.linePos(node?.range?.[0] ?? 0);
  return { line: position.line + context.lineOffset, column: position.col };
}

function report(context, keyPath, code, message) {
  const pathText = keyPath.reduce((text, part) => {
    if (typeof part === 'number') return text + '[' + part + ']';
    return text ? text + '.' + part : part;
  }, '');
  context.diagnostics.push({
    file: context.file,
    ...location(context, keyPath),
    path: pathText,
    code,
    message,
  });
}

function checkKeys(context, value, allowed, keyPath) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) report(context, [...keyPath, key], 'unknown-key', 'Unsupported key "' + key + '".');
  }
}

function checkString(context, value, keyPath, required = false) {
  if (value === undefined && !required) return false;
  if (typeof value !== 'string' || !value.trim()) {
    report(context, keyPath, 'invalid-string', 'Expected a non-empty string.');
    return false;
  }
  return true;
}

function checkBoolean(context, value, keyPath) {
  if (value !== undefined && typeof value !== 'boolean') {
    report(context, keyPath, 'invalid-boolean', 'Expected true or false.');
  }
}

function checkListOrString(context, value, keyPath) {
  if (value === undefined) return;
  if (typeof value === 'string') {
    checkString(context, value, keyPath, true);
    return;
  }
  if (!Array.isArray(value)) {
    report(context, keyPath, 'invalid-list', 'Expected a string or list of strings.');
    return;
  }
  value.forEach((entry, index) => checkString(context, entry, [...keyPath, index], true));
}

function checkValidations(context, value, keyPath, type) {
  if (value === undefined) return;
  if (!isObject(value)) {
    report(context, keyPath, 'invalid-map', 'Expected a mapping.');
    return;
  }
  const allowed = type === 'upload' ? new Set(['required', 'accept']) : new Set(['required']);
  checkKeys(context, value, allowed, keyPath);
  checkBoolean(context, value.required, [...keyPath, 'required']);
  if (type === 'upload' && value.accept !== undefined) {
    checkString(context, value.accept, [...keyPath, 'accept'], true);
  }
}

function checkDropdown(context, attributes, keyPath) {
  checkBoolean(context, attributes.multiple, [...keyPath, 'multiple']);
  const optionsPath = [...keyPath, 'options'];
  if (!Array.isArray(attributes.options) || attributes.options.length === 0) {
    report(context, optionsPath, 'invalid-options', 'Dropdown options must be a non-empty list.');
    return;
  }
  const seen = new Set();
  attributes.options.forEach((option, index) => {
    const optionPath = [...optionsPath, index];
    if (!checkString(context, option, optionPath, true)) return;
    if (seen.has(option)) report(context, optionPath, 'duplicate-option', 'Duplicate option "' + option + '".');
    seen.add(option);
    if (option.trim().toLowerCase() === 'none') {
      report(context, optionPath, 'reserved-option', 'The option "None" is reserved by GitHub.');
    }
    if (attributes.default !== undefined && option.trim().toLowerCase() === 'n/a') {
      report(context, optionPath, 'reserved-option', 'The option "n/a" cannot be used with a default.');
    }
  });
  if (attributes.default !== undefined &&
      (!Number.isInteger(attributes.default) || attributes.default < 0 ||
       attributes.default >= attributes.options.length)) {
    report(context, [...keyPath, 'default'], 'invalid-default', 'Default must be a zero-based index within options.');
  }
}

function parameterize(label) {
  return label.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

function recordLabel(context, references, label, keyPath, reference) {
  if (references.has(reference)) {
    report(context, keyPath, 'duplicate-label',
      'Label "' + label + '" resolves to the same field reference as "' + references.get(reference) + '".');
  } else {
    references.set(reference, label);
  }
}

function checkCheckboxes(context, attributes, keyPath, labels, parentId) {
  const optionsPath = [...keyPath, 'options'];
  if (!Array.isArray(attributes.options) || attributes.options.length === 0) {
    report(context, optionsPath, 'invalid-options', 'Checkbox options must be a non-empty list.');
    return;
  }
  attributes.options.forEach((option, index) => {
    const optionPath = [...optionsPath, index];
    if (!isObject(option)) {
      report(context, optionPath, 'invalid-option', 'Each checkbox option must be a mapping.');
      return;
    }
    checkKeys(context, option, new Set(['label', 'required']), optionPath);
    if (checkString(context, option.label, [...optionPath, 'label'], true)) {
      const optionReference = parameterize(option.label);
      const reference = parentId ? parentId + '/' + optionReference : optionReference;
      recordLabel(context, labels, option.label, [...optionPath, 'label'], reference);
    }
    checkBoolean(context, option.required, [...optionPath, 'required']);
  });
}

function checkElement(context, element, index, ids, labels) {
  const keyPath = ['body', index];
  if (!isObject(element)) {
    report(context, keyPath, 'invalid-element', 'Each body element must be a mapping.');
    return;
  }
  checkKeys(context, element, ELEMENT_KEYS, keyPath);
  if (!ELEMENT_TYPES.has(element.type)) {
    report(context, [...keyPath, 'type'], 'invalid-type', 'Type must be one of: ' + [...ELEMENT_TYPES].join(', ') + '.');
    return;
  }
  if (element.type === 'markdown') {
    if (element.id !== undefined) report(context, [...keyPath, 'id'], 'forbidden-key', 'Markdown elements cannot have an id.');
    if (element.validations !== undefined) report(context, [...keyPath, 'validations'], 'forbidden-key', 'Markdown elements cannot have validations.');
  } else if (element.id !== undefined) {
    if (typeof element.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(element.id)) {
      report(context, [...keyPath, 'id'], 'invalid-id', 'Id may contain only letters, numbers, hyphens, and underscores.');
    } else if (ids.has(element.id)) {
      report(context, [...keyPath, 'id'], 'duplicate-id', 'Duplicate id "' + element.id + '".');
    } else {
      ids.add(element.id);
    }
  }

  const attributesPath = [...keyPath, 'attributes'];
  if (!isObject(element.attributes)) {
    report(context, attributesPath, 'invalid-map', 'Expected an attributes mapping.');
    return;
  }
  const attributes = element.attributes;
  if (element.type === 'markdown') {
    checkKeys(context, attributes, new Set(['value']), attributesPath);
    checkString(context, attributes.value, [...attributesPath, 'value'], true);
    return;
  }

  const allowed = element.type === 'dropdown'
    ? new Set(['label', 'description', 'multiple', 'options', 'default'])
    : element.type === 'checkboxes'
      ? new Set(['label', 'description', 'options'])
      : element.type === 'upload'
        ? new Set(['label', 'description'])
        : element.type === 'textarea'
          ? new Set([...TEXT_KEYS, 'render'])
          : TEXT_KEYS;
  checkKeys(context, attributes, allowed, attributesPath);
  if (checkString(context, attributes.label, [...attributesPath, 'label'], true)) {
    const reference = typeof element.id === 'string' && element.id
      ? element.id : parameterize(attributes.label);
    recordLabel(context, labels, attributes.label, [...attributesPath, 'label'], reference);
  }
  if (attributes.description !== undefined) {
    checkString(context, attributes.description, [...attributesPath, 'description'], true);
  }
  if (element.type === 'input' || element.type === 'textarea') {
    for (const key of ['placeholder', 'value']) {
      if (attributes[key] !== undefined) checkString(context, attributes[key], [...attributesPath, key], true);
    }
  }
  if (element.type === 'textarea' && attributes.render !== undefined) {
    checkString(context, attributes.render, [...attributesPath, 'render'], true);
  }
  if (element.type === 'dropdown') checkDropdown(context, attributes, attributesPath);
  if (element.type === 'checkboxes') {
    checkCheckboxes(context, attributes, attributesPath, labels,
      typeof element.id === 'string' ? element.id : null);
  }
  checkValidations(context, element.validations, [...keyPath, 'validations'], element.type);
}

function checkForm(context, value) {
  if (!isObject(value)) {
    report(context, [], 'invalid-root', 'Issue form must be a YAML mapping.');
    return;
  }
  checkKeys(context, value, FORM_KEYS, []);
  checkString(context, value.name, ['name'], true);
  checkString(context, value.description, ['description'], true);
  for (const key of ['title', 'type']) {
    if (value[key] !== undefined) checkString(context, value[key], [key], true);
  }
  for (const key of ['assignees', 'labels', 'projects']) checkListOrString(context, value[key], [key]);
  if (!Array.isArray(value.body) || value.body.length === 0) {
    report(context, ['body'], 'invalid-body', 'Body must be a non-empty list.');
    return;
  }
  const ids = new Set();
  const labels = new Map();
  value.body.forEach((element, index) => checkElement(context, element, index, ids, labels));
  if (!value.body.some((element) => isObject(element) && ELEMENT_TYPES.has(element.type) && element.type !== 'markdown')) {
    report(context, ['body'], 'no-input', 'Body must contain at least one non-markdown field.');
  }
}

function checkConfig(context, value) {
  if (!isObject(value)) {
    report(context, [], 'invalid-root', 'Template chooser config must be a YAML mapping.');
    return;
  }
  checkKeys(context, value, new Set(['blank_issues_enabled', 'contact_links']), []);
  checkBoolean(context, value.blank_issues_enabled, ['blank_issues_enabled']);
  if (value.contact_links === undefined) return;
  if (!Array.isArray(value.contact_links)) {
    report(context, ['contact_links'], 'invalid-list', 'Contact links must be a list.');
    return;
  }
  value.contact_links.forEach((link, index) => {
    const keyPath = ['contact_links', index];
    if (!isObject(link)) {
      report(context, keyPath, 'invalid-link', 'Each contact link must be a mapping.');
      return;
    }
    checkKeys(context, link, new Set(['name', 'url', 'about']), keyPath);
    checkString(context, link.name, [...keyPath, 'name'], true);
    checkString(context, link.about, [...keyPath, 'about'], true);
    if (checkString(context, link.url, [...keyPath, 'url'], true)) {
      try {
        const parsed = new URL(link.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
      } catch {
        report(context, [...keyPath, 'url'], 'invalid-url', 'Expected an absolute http or https URL.');
      }
    }
  });
}

function parseYaml(source, file, lineOffset = 0) {
  const lines = new LineCounter();
  const document = parseDocument(source, { version: '1.1', uniqueKeys: true, lineCounter: lines });
  const context = { file, lineOffset, lines, document, diagnostics: [] };
  for (const error of document.errors) {
    const position = error.linePos?.[0] ?? lines.linePos(error.pos?.[0] ?? 0);
    context.diagnostics.push({
      file,
      line: position.line + lineOffset,
      column: position.col,
      path: '',
      code: 'yaml-error',
      message: error.message.split('\n')[0],
    });
  }
  if (document.errors.length > 0) return { context, value: null, validYaml: false };
  try {
    return { context, value: document.toJS({ maxAliasCount: 100 }), validYaml: true };
  } catch (error) {
    report(context, [], 'yaml-error', error.message);
    return { context, value: null, validYaml: false };
  }
}

export function lintSource(source, file, kind = 'form') {
  let yamlSource = source;
  let lineOffset = 0;
  if (kind === 'markdown') {
    const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (!frontmatter) {
      return { name: null, diagnostics: [{
        file, line: 1, column: 1, path: '',
        code: 'missing-frontmatter', message: 'Markdown issue templates need YAML frontmatter.',
      }] };
    }
    yamlSource = frontmatter[1];
    lineOffset = 1;
  }
  const { context, value, validYaml } = parseYaml(yamlSource, file, lineOffset);
  if (!validYaml) return { name: null, diagnostics: context.diagnostics };
  if (kind === 'config') checkConfig(context, value);
  else if (kind === 'markdown') {
    if (!isObject(value)) report(context, [], 'invalid-root', 'Frontmatter must be a YAML mapping.');
    else {
      checkString(context, value.name, ['name'], true);
      checkString(context, value.about, ['about'], true);
    }
  } else checkForm(context, value);
  return {
    name: kind === 'config' || !isObject(value) || typeof value.name !== 'string' ? null : value.name.trim(),
    diagnostics: context.diagnostics,
  };
}

function filesFor(target) {
  const absolute = path.resolve(target);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) throw new Error('Not a file or directory: ' + absolute);
  const nested = path.join(absolute, '.github', 'ISSUE_TEMPLATE');
  const directory = fs.existsSync(nested) && fs.statSync(nested).isDirectory() ? nested : absolute;
  if (directory === absolute && path.basename(directory).toLowerCase() !== 'issue_template') {
    throw new Error('No .github/ISSUE_TEMPLATE directory found in ' + absolute);
  }
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ya?ml|md)$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  if (files.length === 0) throw new Error('No issue template files found in ' + directory);
  return files;
}

export function lintPath(target = '.') {
  const files = filesFor(target);
  const diagnostics = [];
  const names = new Map();
  for (const file of files) {
    const filename = path.basename(file).toLowerCase();
    if (filename.endsWith('.yaml')) {
      diagnostics.push({
        file, line: 1, column: 1, path: '',
        code: 'unsupported-extension',
        message: 'GitHub issue forms and chooser config use .yml files; rename this file to .yml.',
      });
    }
    const kind = filename === 'config.yml' || filename === 'config.yaml'
      ? 'config'
      : filename.endsWith('.md') ? 'markdown' : 'form';
    const result = lintSource(fs.readFileSync(file, 'utf8'), file, kind);
    diagnostics.push(...result.diagnostics);
    if (result.name) {
      const key = result.name.toLowerCase();
      if (names.has(key)) {
        diagnostics.push({
          file, line: 1, column: 1, path: 'name',
          code: 'duplicate-template-name',
          message: 'Template name "' + result.name + '" is also used in ' + names.get(key) + '.',
        });
      } else names.set(key, file);
    }
  }
  diagnostics.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.code.localeCompare(b.code));
  return { files, diagnostics };
}
