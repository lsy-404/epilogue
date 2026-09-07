'use strict';

const PAGE_SIZE = 400;
const DAY = 86400000;

function boundedNumber(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function recordTime(record) {
  return record.fileMtime || Date.parse(record.indexedAt) || 0;
}

function queryLibrary(records, options = {}) {
  options ??= {};
  const query = String(options.query || '').trim().toLowerCase();
  const offset = Math.floor(boundedNumber(options.offset, 0, 0, Number.MAX_SAFE_INTEGER));
  const limit = Math.floor(boundedNumber(options.limit, PAGE_SIZE, 1, PAGE_SIZE));
  let min = Infinity;
  let max = -Infinity;
  for (const record of records) {
    const time = recordTime(record);
    if (time < min) min = time;
    if (time > max) max = time;
  }
  if (!records.length) { min = 0; max = Date.now(); }
  const start = boundedNumber(options.from, 0, 0, 100);
  const end = boundedNumber(options.to, 100, 0, 100);
  const from = min + (max - min) * Math.min(start, end) / 100;
  const to = min + (max - min) * Math.max(start, end) / 100;
  const rows = [];
  let total = 0;
  for (const record of records) {
    const time = recordTime(record);
    if (time < from - DAY || time > to + DAY) continue;
    if (query && !String(record.fileName || '').toLowerCase().includes(query)
      && !String(record.summary || '').toLowerCase().includes(query)
      && !(record.keywords || []).join(' ').toLowerCase().includes(query)) continue;
    if (total++ < offset || rows.length >= limit) continue;
    rows.push({
      filePath: record.filePath, fileName: record.fileName, kind: record.kind,
      summary: record.summary, hasVector: (record.vecDim || 0) > 0,
    });
  }
  return { rows, total, offset, from, to, recordsTotal: records.length };
}

function recentRecords(records, count = 8) {
  const limit = Math.floor(boundedNumber(count, 8, 0, PAGE_SIZE));
  const recent = [];
  if (!limit) return recent;
  for (let position = records.length - 1; position >= 0; position--) {
    const record = records[position];
    const time = record.indexedAt || '';
    let index = recent.length;
    while (index > 0 && time.localeCompare(recent[index - 1].indexedAt || '') >= 0) index--;
    if (index >= limit) continue;
    recent.splice(index, 0, record);
    if (recent.length > limit) recent.pop();
  }
  return recent.map(({ filePath, fileName, kind, summary }) => ({ filePath, fileName, kind, summary }));
}

module.exports = { queryLibrary, recentRecords };
