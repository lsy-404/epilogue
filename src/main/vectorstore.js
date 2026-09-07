'use strict';
// 本地向量库：避免全量加载进内存。
//   index.json   gzip JSON 元数据（无向量；record.vecDim 标维度），常驻内存的只有这部分
//   vectors.bin  'EVB1' 魔数 + count(u32le)，每条 [idLen u16le][id utf8][dim u16le][f32le×dim]
// 向量检索时流扫 bin，扫完即弃不常驻；
// 新写入向量在 pendingVec 暂存，flush 时与旧 bin 合并重写（临时文件 + rename 原子）。
// 旧单文件在加载时解出，并在下次写入时落入双文件。
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');

const VEC_PREFIX = 'f32:';
const BIN_MAGIC = Buffer.from('EVB1');
const SCAN_BUFFER_BYTES = 256 * 1024;

function toF32(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return Float32Array.from(v);
  if (typeof v === 'string' && v.startsWith(VEC_PREFIX)) {
    const buf = Buffer.from(v.slice(VEC_PREFIX.length), 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  return null;
}

function hasVec(r) {
  return (r.vecDim || 0) > 0;
}

function writeAllSync(file, buffer, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(
      file,
      buffer,
      offset,
      buffer.length - offset,
      position == null ? null : position + offset,
    );
    if (!written) throw new Error('Could not finish writing vector data');
    offset += written;
  }
}

class VectorStore {
  constructor(file) {
    this.file = file;
    this.vecFile = path.join(path.dirname(file), 'vectors.bin');
    this.records = [];
    this.pathIndex = new Map(); // filePath -> records index，大库 upsert/get 保持 O(1)
    this.idIndex = new Map(); // id -> record，检索时不必重建映射
    this.pendingVec = new Map(); // id -> Float32Array（新写入/迁移暂存，flush 后清）
    this.vectorDirty = false;
    try {
      const buf = fs.readFileSync(file);
      const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      this.records = JSON.parse(text);
      let migrated = false;
      for (const r of this.records) {
        if (r.vector != null) {
          // 旧单文件格式：向量内嵌 —— 解出暂存，flush 时落 bin
          const f = toF32(r.vector);
          if (f) {
            this.pendingVec.set(r.id, f);
            r.vecDim = f.length;
          }
          delete r.vector;
          migrated = true;
        }
      }
      if (migrated) {
        this.vectorDirty = true;
        this.save();
      }
    } catch {
      /* 首次运行 */
    }
    this._rebuildPathIndex();
  }

  _rebuildPathIndex() {
    this.pathIndex.clear();
    this.idIndex.clear();
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index];
      this.pathIndex.set(record.filePath, index);
      this.idIndex.set(record.id, record);
    }
  }

  // 写盘防抖：批量索引时合并为少量全量写；退出前由 flush() 兜底落盘
  save() {
    this.dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 200);
    this._saveTimer.unref?.();
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      // 先原子替换向量文件；若随后崩溃，旧元数据至多忽略多出的向量，
      // 不会指向不存在的新记录。下次 flush 会按内存中的 records 再次收敛。
      if (this.vectorDirty) this._rewriteBin();
      const metadata = zlib.gzipSync(Buffer.from(JSON.stringify(this.records)), { level: 1 });
      const temp = `${this.file}.tmp`;
      let output;
      try {
        output = fs.openSync(temp, 'w');
        writeAllSync(output, metadata);
        fs.fsyncSync(output);
        fs.closeSync(output);
        output = null;
        fs.renameSync(temp, this.file);
      } catch (error) {
        if (output != null) fs.closeSync(output);
        fs.rmSync(temp, { force: true });
        throw error;
      }
      this.dirty = false;
      this.vectorDirty = false;
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  // 合并重写 vectors.bin：旧 bin 中仍存活且未被更新的条目原样拷贝 + pendingVec 追加
  _rewriteBin() {
    const alive = new Set(this.records.filter(hasVec).map((r) => r.id));
    let count = 0;
    const tmp = `${this.vecFile}.tmp`;
    let output;
    try {
      output = fs.openSync(tmp, 'w');
      writeAllSync(output, Buffer.alloc(8)); // 保留 header，计数最后回填
      const writeRecord = (id, dim, vecBuf) => {
        const idBuf = Buffer.from(id, 'utf8');
        if (idBuf.length > 0xffff || dim > 0xffff) throw new Error('Vector record exceeds binary format limits');
        const head = Buffer.allocUnsafe(2 + idBuf.length + 2);
        head.writeUInt16LE(idBuf.length, 0);
        idBuf.copy(head, 2);
        head.writeUInt16LE(dim, 2 + idBuf.length);
        writeAllSync(output, head);
        writeAllSync(output, vecBuf);
        count += 1;
      };

      this._scanBin((id, dim, vecBuf) => {
        if (!alive.has(id) || this.pendingVec.has(id)) return;
        writeRecord(id, dim, vecBuf);
      });
      for (const [id, vector] of this.pendingVec) {
        if (!alive.has(id)) continue;
        writeRecord(id, vector.length, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
      }

      const header = Buffer.allocUnsafe(8);
      BIN_MAGIC.copy(header, 0);
      header.writeUInt32LE(count, 4);
      writeAllSync(output, header, 0);
      fs.fsyncSync(output);
      fs.closeSync(output);
      output = null;
      fs.renameSync(tmp, this.vecFile); // 原子替换
      this.pendingVec.clear();
    } catch (error) {
      if (output != null) fs.closeSync(output);
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  // 顺序流扫 bin：只保留一个向量缓冲，不再 readFileSync 整个向量库。
  // cb 中的 vecBuf 仅在当次回调有效；文件缺失/截断时安全停止。
  _scanBin(cb) {
    let input;
    try {
      input = fs.openSync(this.vecFile, 'r');
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(input).size;
      const chunk = Buffer.allocUnsafe(SCAN_BUFFER_BYTES);
      let chunkOffset = 0;
      let chunkLength = 0;
      let filePosition = 0;
      let position = 0;
      const refill = () => {
        chunkOffset = 0;
        chunkLength = fs.readSync(input, chunk, 0, chunk.length, filePosition);
        filePosition += chunkLength;
        return chunkLength > 0;
      };
      const readInto = (target) => {
        let targetOffset = 0;
        while (targetOffset < target.length) {
          if (chunkOffset === chunkLength && !refill()) return false;
          const bytes = Math.min(chunkLength - chunkOffset, target.length - targetOffset);
          chunk.copy(target, targetOffset, chunkOffset, chunkOffset + bytes);
          chunkOffset += bytes;
          targetOffset += bytes;
          position += bytes;
        }
        return true;
      };
      const header = Buffer.allocUnsafe(8);
      if (size < header.length || !readInto(header) || !header.subarray(0, 4).equals(BIN_MAGIC)) return;
      const count = header.readUInt32LE(4);
      let vectorBuffer = Buffer.allocUnsafe(0);
      let idAndDimension = Buffer.allocUnsafe(0);
      const short = Buffer.allocUnsafe(2);
      for (let index = 0; index < count; index += 1) {
        if (position + 4 > size || !readInto(short)) return;
        const idLength = short.readUInt16LE(0);
        if (!idLength || position + idLength + 2 > size) return;
        if (idAndDimension.length < idLength + 2) idAndDimension = Buffer.allocUnsafe(idLength + 2);
        const idAndDimensionView = idAndDimension.subarray(0, idLength + 2);
        if (!readInto(idAndDimensionView)) return;
        const id = idAndDimensionView.subarray(0, idLength).toString('utf8');
        const dimension = idAndDimensionView.readUInt16LE(idLength);
        const byteLength = dimension * 4;
        if (!dimension || position + byteLength > size) return;
        if (vectorBuffer.length < byteLength + 3) vectorBuffer = Buffer.allocUnsafe(byteLength + 3);
        const padding = (4 - (vectorBuffer.byteOffset % 4)) % 4;
        const vectorView = vectorBuffer.subarray(padding, padding + byteLength);
        if (!readInto(vectorView)) return;
        cb(id, dimension, vectorView);
      }
    } finally {
      fs.closeSync(input);
    }
  }

  upsert(record) {
    const i = this.pathIndex.get(record.filePath) ?? -1;
    const existing = i >= 0 ? this.records[i] : null;
    const withId = { id: existing ? existing.id : `f_${crypto.randomUUID()}`, ...record };
    const f = withId.vector != null ? toF32(withId.vector) : null;
    delete withId.vector; // 向量不驻留 records
    if (f) {
      this.pendingVec.set(withId.id, f);
      withId.vecDim = f.length;
      this.vectorDirty = true;
    } else if (existing) {
      withId.vecDim = existing.vecDim;
    } else {
      delete withId.vecDim;
    }
    if (i >= 0) {
      this.records[i] = withId;
      this.idIndex.set(withId.id, withId);
    } else {
      this.pathIndex.set(record.filePath, this.records.length);
      this.records.push(withId);
      this.idIndex.set(withId.id, withId);
    }
    this.save();
    return withId;
  }

  remove(filePath) {
    const index = this.pathIndex.get(filePath);
    if (index == null) return;
    const record = this.records[index];
    this.pendingVec.delete(record.id);
    if (hasVec(record)) this.vectorDirty = true;
    this.records.splice(index, 1);
    this._rebuildPathIndex();
    this.save();
  }

  // 文件被归类移动后更新路径
  updatePath(oldPath, newPath) {
    const index = this.pathIndex.get(oldPath);
    if (index != null) {
      const r = this.records[index];
      r.filePath = newPath;
      r.fileName = path.basename(newPath);
      this.pathIndex.delete(oldPath);
      this.pathIndex.set(newPath, index);
      this.save();
    }
  }

  get(filePath) {
    const index = this.pathIndex.get(filePath);
    return index == null ? undefined : this.records[index];
  }

  all() {
    return this.records;
  }

  stats() {
    return { total: this.records.length, withVector: this.records.filter(hasVec).length };
  }

  // 按文件类型统计：条数 + 字节估算（元数据 JSON 长度 + 向量 dim×4）
  kindStats() {
    const out = {};
    for (const r of this.records) {
      const k = r.kind || 'other';
      if (!out[k]) out[k] = { count: 0, bytes: 0 };
      out[k].count++;
      out[k].bytes += JSON.stringify(r).length + (r.vecDim || 0) * 4;
    }
    return out;
  }

  // 删除某类全部索引记录（不动原文件，重新索引可恢复），返回删除条数
  removeKind(kind) {
    const before = this.records.length;
    const gone = this.records.filter((r) => (r.kind || 'other') === kind);
    for (const r of gone) {
      this.pendingVec.delete(r.id);
      if (hasVec(r)) this.vectorDirty = true;
    }
    this.records = this.records.filter((r) => (r.kind || 'other') !== kind);
    this._rebuildPathIndex();
    this.save();
    return before - this.records.length;
  }

  static cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  // 向量检索：流扫 bin，固定容量 top-k 堆避免为全部候选排序。
  searchByVector(queryVector, topK = 8) {
    const q = toF32(queryVector);
    const limit = Math.max(0, Math.floor(Number(topK) || 0));
    if (!q || !limit) return [];
    const hits = [];
    const consider = (record, score) => {
      const hit = { record, score };
      if (hits.length < limit) {
        hits.push(hit);
        for (let child = hits.length - 1; child > 0;) {
          const parent = (child - 1) >> 1;
          if (hits[parent].score <= hits[child].score) break;
          [hits[parent], hits[child]] = [hits[child], hits[parent]];
          child = parent;
        }
      } else if (score > hits[0].score) {
        hits[0] = hit;
        for (let parent = 0;;) {
          const left = parent * 2 + 1;
          if (left >= hits.length) break;
          const right = left + 1;
          const child = right < hits.length && hits[right].score < hits[left].score ? right : left;
          if (hits[parent].score <= hits[child].score) break;
          [hits[parent], hits[child]] = [hits[child], hits[parent]];
          parent = child;
        }
      }
    };
    this._scanBin((id, dim, vecBuf) => {
      if (dim !== q.length || this.pendingVec.has(id)) return;
      const record = this.idIndex.get(id);
      if (!record) return;
      const view = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, dim);
      consider(record, VectorStore.cosine(q, view));
    });
    for (const [id, f] of this.pendingVec) {
      const record = this.idIndex.get(id);
      if (record && f.length === q.length) consider(record, VectorStore.cosine(q, f));
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  static tokenize(text) {
    // 中英混合：英文按词、中文按双字滑窗
    const tokens = new Set();
    for (const m of (text || '').toLowerCase().matchAll(/[a-z0-9]+|[一-鿿]+/g)) {
      const seg = m[0];
      if (/^[a-z0-9]+$/.test(seg)) {
        tokens.add(seg);
      } else {
        for (let i = 0; i < seg.length; i++) {
          tokens.add(seg[i]);
          if (i + 1 < seg.length) tokens.add(seg.slice(i, i + 2));
        }
      }
    }
    return tokens;
  }

  searchByKeywords(query, topK = 8) {
    const q = VectorStore.tokenize(query);
    if (!q.size) return [];
    return this.records
      .map((r) => {
        // filePath 入 hay：文件夹名（如「回归线」）也参与关键词召回，对存量索引立即生效
        const hay = VectorStore.tokenize(`${r.filePath} ${r.fileName} ${(r.keywords || []).join(' ')} ${r.summary || ''}`);
        let hit = 0;
        for (const t of q) if (hay.has(t)) hit++;
        return { record: r, score: hit / q.size };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

module.exports = { VectorStore, hasVec, toF32 };
