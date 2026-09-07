'use strict';

const { performance } = require('node:perf_hooks');
const { queryLibrary, recentRecords } = require('../src/main/libraryQuery');

const records = Array.from({ length: 25000 }, (_, index) => ({
  id: `file_${index}`, filePath: `/files/project/${index}.txt`, fileName: `${index}.txt`,
  kind: 'text', summary: 'Document preview. '.repeat(10), keywords: ['project', 'document'],
  fileMtime: 1700000000000 + index * 1000, indexedAt: new Date(1700000000000 + index * 1000).toISOString(),
  vecDim: 384, sizeBytes: 1024, indexedMode: 'full', transcriptPreview: 'Transcript. '.repeat(40),
}));
function measure(name, fn) {
  fn();
  const timings = [];
  let result;
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    result = fn();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return { name, medianMs: +timings[3].toFixed(2), payloadBytes: Buffer.byteLength(JSON.stringify(result)) };
}
console.log(JSON.stringify([
  measure('full-library-transfer', () => structuredClone(records.map((r) => ({ ...r, vector: undefined, transcriptPreview: undefined, hasVector: true })))),
  measure('paged-library-transfer', () => structuredClone(queryLibrary(records))),
  measure('full-sort-recent', () => [...records].sort((a, b) => b.indexedAt.localeCompare(a.indexedAt)).slice(0, 8)
    .map(({ filePath, fileName, kind, summary }) => ({ filePath, fileName, kind, summary }))),
  measure('bounded-recent', () => recentRecords(records)),
], null, 2));
