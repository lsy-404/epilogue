'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TRANSACTIONS = 100;

function moveFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.rmSync(source);
  }
}

class OperationJournal {
  constructor(file) {
    this.file = file;
    this.transactions = [];
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.transactions = parsed.slice(-MAX_TRANSACTIONS);
    } catch {
      this.transactions = [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    let output;
    try {
      output = fs.openSync(temp, 'w');
      fs.writeFileSync(output, JSON.stringify(this.transactions, null, 2), 'utf8');
      fs.fsyncSync(output);
      fs.closeSync(output);
      output = null;
      fs.renameSync(temp, this.file);
    } catch (error) {
      if (output != null) fs.closeSync(output);
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  begin(source = 'manual') {
    const transaction = {
      id: `tx_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      source,
      operations: [],
    };
    this.transactions.push(transaction);
    if (this.transactions.length > MAX_TRANSACTIONS) {
      this.transactions.splice(0, this.transactions.length - MAX_TRANSACTIONS);
    }
    this._save();
    return transaction;
  }

  stage(transactionId, operation) {
    const transaction = this.transactions.find((item) => item.id === transactionId);
    if (!transaction) throw new Error('Operation transaction was not found');
    if (operation?.kind !== 'move' && operation?.kind !== 'trash') {
      throw new Error('Unsupported operation kind');
    }
    const entry = {
      id: `op_${crypto.randomUUID()}`,
      kind: operation.kind,
      from: String(operation.from || ''),
      to: operation.kind === 'move' ? String(operation.to || '') : undefined,
      reversible: operation.kind === 'move',
      status: 'planned',
    };
    if (!entry.from || (entry.kind === 'move' && !entry.to)) {
      throw new Error('Operation paths are required');
    }
    transaction.operations.push(entry);
    this._save();
    return entry;
  }

  markApplied(transactionId, operationId) {
    const transaction = this.transactions.find((item) => item.id === transactionId);
    const operation = transaction?.operations.find((item) => item.id === operationId);
    if (!operation) throw new Error('Operation journal entry was not found');
    operation.status = 'applied';
    operation.appliedAt = new Date().toISOString();
    this._save();
    return operation;
  }

  record(operations, source = 'manual') {
    const clean = (operations || [])
      .filter((operation) => operation?.kind === 'move' || operation?.kind === 'trash')
      .map((operation) => ({
        kind: operation.kind,
        from: String(operation.from || ''),
        to: operation.kind === 'move' ? String(operation.to || '') : undefined,
        reversible: operation.kind === 'move',
      }))
      .filter((operation) => operation.from && (operation.kind !== 'move' || operation.to));
    if (!clean.length) return null;

    const transaction = this.begin(source);
    transaction.operations = clean.map((operation) => ({
      ...operation,
      id: `op_${crypto.randomUUID()}`,
      status: 'applied',
      appliedAt: new Date().toISOString(),
    }));
    this._save();
    return transaction;
  }

  _isUndoCandidate(operation) {
    if (!operation.reversible || operation.undoneAt) return false;
    // Entries written by v0.4 previews had no status and were recorded only
    // after a successful move, so they remain backward-compatible.
    if (!operation.status || operation.status === 'applied') return true;
    // A process can stop after the filesystem mutation but before markApplied.
    // The pre-registered destination is enough to expose a safe recovery path.
    return operation.status === 'planned' && fs.existsSync(operation.to);
  }

  latestUndoable() {
    for (let index = this.transactions.length - 1; index >= 0; index -= 1) {
      const transaction = this.transactions[index];
      const pending = transaction.operations.filter((operation) => this._isUndoCandidate(operation));
      if (pending.length) {
        return {
          id: transaction.id,
          createdAt: transaction.createdAt,
          source: transaction.source,
          count: pending.length,
        };
      }
    }
    return null;
  }

  undo(transactionId, store) {
    const transaction = this.transactions.find((item) => item.id === transactionId);
    if (!transaction) throw new Error('Operation transaction was not found');

    const results = [];
    const operations = [...transaction.operations]
      .filter((operation) => this._isUndoCandidate(operation))
      .reverse();
    for (const operation of operations) {
      try {
        const destinationExists = fs.existsSync(operation.to);
        const originalExists = fs.existsSync(operation.from);
        // A crash can happen after the filesystem move but before the journal
        // checkpoint. Treat that exact state as already restored so retrying an
        // undo is idempotent instead of permanently reporting a conflict.
        if (!destinationExists && originalExists) {
          store?.updatePath?.(operation.to, operation.from);
          operation.status = 'applied';
          operation.undoneAt = new Date().toISOString();
          this._save();
          results.push({ from: operation.to, restoredPath: operation.from, recovered: true });
          continue;
        }
        if (!destinationExists) throw new Error('Moved file no longer exists');
        if (originalExists) throw new Error('Original path is already occupied');
        moveFile(operation.to, operation.from);
        store?.updatePath?.(operation.to, operation.from);
        operation.status = 'applied';
        operation.undoneAt = new Date().toISOString();
        this._save();
        results.push({ from: operation.to, restoredPath: operation.from });
      } catch (error) {
        results.push({ from: operation.to, restoredPath: operation.from, error: error.message });
      }
    }

    const relevant = transaction.operations.filter(
      (operation) => operation.reversible && (operation.undoneAt || this._isUndoCandidate(operation)),
    );
    const complete = relevant.length > 0 && relevant.every((operation) => operation.undoneAt);
    transaction.undoStatus = complete ? 'complete' : results.some((result) => !result.error) ? 'partial' : 'failed';
    transaction.lastUndoAt = new Date().toISOString();
    this._save();
    return { transactionId: transaction.id, complete, results };
  }
}

module.exports = { OperationJournal, moveFile, MAX_TRANSACTIONS };
