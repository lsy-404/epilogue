'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { OperationJournal } = require('../src/main/operationJournal');

test('operation journal persists moves and restores them in reverse order', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const destinationDir = path.join(root, 'destination');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(destinationDir);
  const originalA = path.join(sourceDir, 'a.txt');
  const originalB = path.join(sourceDir, 'b.txt');
  const movedA = path.join(destinationDir, 'a.txt');
  const movedB = path.join(destinationDir, 'b.txt');
  fs.writeFileSync(movedA, 'a');
  fs.writeFileSync(movedB, 'b');

  const file = path.join(root, 'operations.json');
  const journal = new OperationJournal(file);
  const transaction = journal.record([
    { kind: 'move', from: originalA, to: movedA },
    { kind: 'move', from: originalB, to: movedB },
  ]);
  assert.equal(journal.latestUndoable().count, 2);

  const pathUpdates = [];
  const reloaded = new OperationJournal(file);
  const outcome = reloaded.undo(transaction.id, {
    updatePath: (from, to) => pathUpdates.push([from, to]),
  });

  assert.equal(outcome.complete, true);
  assert.deepEqual(pathUpdates, [
    [movedB, originalB],
    [movedA, originalA],
  ]);
  assert.equal(fs.readFileSync(originalA, 'utf8'), 'a');
  assert.equal(fs.readFileSync(originalB, 'utf8'), 'b');
  assert.equal(reloaded.latestUndoable(), null);
});

test('undo refuses to overwrite an occupied original path and remains retryable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'source', 'report.txt');
  const moved = path.join(root, 'destination', 'report.txt');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.writeFileSync(original, 'new occupant');
  fs.writeFileSync(moved, 'moved file');

  const journal = new OperationJournal(path.join(root, 'operations.json'));
  const transaction = journal.record([{ kind: 'move', from: original, to: moved }]);
  const outcome = journal.undo(transaction.id, { updatePath() {} });

  assert.equal(outcome.complete, false);
  assert.match(outcome.results[0].error, /already occupied/);
  assert.equal(fs.readFileSync(original, 'utf8'), 'new occupant');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'moved file');
  assert.equal(journal.latestUndoable().id, transaction.id);
});

test('trash operations are journaled but never exposed as programmatic undo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-journal-'));
  try {
    const journal = new OperationJournal(path.join(root, 'operations.json'));
    journal.record([{ kind: 'trash', from: path.join(root, 'old.tmp') }]);
    assert.equal(journal.latestUndoable(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('undo recovers idempotently when a prior run moved the file before checkpointing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'source', 'resume.txt');
  const moved = path.join(root, 'destination', 'resume.txt');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, 'already restored');

  const journal = new OperationJournal(path.join(root, 'operations.json'));
  const transaction = journal.record([{ kind: 'move', from: original, to: moved }]);
  const updates = [];
  const outcome = journal.undo(transaction.id, {
    updatePath: (from, to) => updates.push([from, to]),
  });

  assert.equal(outcome.complete, true);
  assert.equal(outcome.results[0].recovered, true);
  assert.deepEqual(updates, [[moved, original]]);
  assert.equal(journal.latestUndoable(), null);
});

test('write-ahead entry recovers a move completed before its applied checkpoint', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'source', 'interrupted.txt');
  const moved = path.join(root, 'destination', 'interrupted.txt');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.writeFileSync(original, 'recover me');

  const file = path.join(root, 'operations.json');
  const journal = new OperationJournal(file);
  const transaction = journal.begin('test');
  journal.stage(transaction.id, { kind: 'move', from: original, to: moved });
  fs.renameSync(original, moved); // simulate termination before markApplied

  const reloaded = new OperationJournal(file);
  assert.equal(reloaded.latestUndoable().id, transaction.id);
  const outcome = reloaded.undo(transaction.id, { updatePath() {} });
  assert.equal(outcome.complete, true);
  assert.equal(fs.readFileSync(original, 'utf8'), 'recover me');
  assert.equal(fs.existsSync(moved), false);
});

test('write-ahead entry is not offered when its filesystem move never started', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'source.txt');
  const moved = path.join(root, 'destination.txt');
  fs.writeFileSync(original, 'untouched');

  const journal = new OperationJournal(path.join(root, 'operations.json'));
  const transaction = journal.begin('test');
  journal.stage(transaction.id, { kind: 'move', from: original, to: moved });

  assert.equal(journal.latestUndoable(), null);
});

test('write-ahead recovery reports a conflict when a cross-device copy left both paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'original.txt');
  const moved = path.join(root, 'moved.txt');
  fs.writeFileSync(original, 'original still present');
  fs.writeFileSync(moved, 'copied destination');

  const journal = new OperationJournal(path.join(root, 'operations.json'));
  const transaction = journal.begin('test');
  journal.stage(transaction.id, { kind: 'move', from: original, to: moved });

  const outcome = journal.undo(transaction.id, { updatePath() {} });
  assert.equal(outcome.complete, false);
  assert.match(outcome.results[0].error, /already occupied/);
  assert.equal(journal.latestUndoable().id, transaction.id);
});
