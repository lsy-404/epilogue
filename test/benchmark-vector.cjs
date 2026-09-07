'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const COUNT = 25_000;
const DIMENSION = 384;
const RUNS = 5;
const modulePath = path.resolve(process.argv[2] || path.join(__dirname, '../src/main/vectorstore.js'));
const { VectorStore } = require(modulePath);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function createFixture(root) {
  const indexFile = path.join(root, 'index.json');
  const vector = new Float32Array(DIMENSION);
  vector[0] = 1;
  const store = new VectorStore(indexFile);
  for (let index = 0; index < COUNT; index += 1) {
    store.upsert({
      filePath: path.join(root, `entry-${index}.txt`),
      fileName: `entry-${index}.txt`,
      kind: 'text',
      summary: '',
      keywords: [],
      vector,
    });
  }
  store.flush();
  return { indexFile, vector };
}

function measure(indexFile, vector) {
  const store = new VectorStore(indexFile);
  store.searchByVector(vector, 8);
  const originalRead = fs.readSync;
  const timings = [];
  const reads = [];
  try {
    for (let run = 0; run < RUNS; run += 1) {
      let count = 0;
      fs.readSync = function countedRead(...args) {
        count += 1;
        return originalRead.apply(this, args);
      };
      const started = performance.now();
      const hits = store.searchByVector(vector, 8);
      timings.push(performance.now() - started);
      reads.push(count);
      if (hits.length !== 8) throw new Error(`Expected 8 hits, received ${hits.length}`);
    }
  } finally {
    fs.readSync = originalRead;
  }
  return {
    milliseconds: timings.map((value) => Number(value.toFixed(1))),
    medianMilliseconds: Number(median(timings).toFixed(1)),
    readSync: reads,
    medianReadSync: median(reads),
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-vector-benchmark-'));
try {
  const { indexFile, vector } = createFixture(root);
  console.log(JSON.stringify({
    modulePath,
    records: COUNT,
    dimension: DIMENSION,
    vectorBytes: fs.statSync(path.join(root, 'vectors.bin')).size,
    result: measure(indexFile, vector),
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
