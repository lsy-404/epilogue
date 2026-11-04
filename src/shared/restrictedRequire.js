'use strict';
const { builtinModules } = require('node:module');

const BUILTINS = new Set(builtinModules);

// Extension code may load Node built-ins only; everything else must be bundled into the package.
function restrictedRequire(id) {
  if (typeof id === 'string' && (id.startsWith('node:') || BUILTINS.has(id))) return require(id);
  throw new Error(`require of '${id}' is not allowed in extensions`);
}

module.exports = { restrictedRequire };
