'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const LGPL_ALLOWED = [/^@img\/sharp-/];

function termAllowed(term, name) {
  const id = term.replace(/[()]/g, '').trim();
  if (!id || /^unknown$|^unlicensed$|^see license/i.test(id)) return false;
  if (/LGPL/i.test(id)) return LGPL_ALLOWED.some((re) => re.test(name));
  return !/GPL|SSPL/i.test(id);
}

// "A OR B" passes if any alternative passes; "A AND B" requires every term.
function expressionAllowed(expression, name) {
  return expression
    .split(/\s+OR\s+/i)
    .some((alternative) => alternative.split(/\s+AND\s+/i).every((term) => termAllowed(term, name)));
}

test('production dependencies carry no GPL, AGPL, SSPL or unknown licenses', () => {
  const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const byLicense = JSON.parse(result.stdout);
  const offenders = [];
  for (const [expression, packages] of Object.entries(byLicense)) {
    for (const pkg of packages) {
      if (!expressionAllowed(expression, pkg.name)) offenders.push(`${pkg.name}@${pkg.versions?.join(',')} (${expression})`);
    }
  }
  assert.deepEqual(offenders, []);
});
