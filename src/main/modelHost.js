'use strict';
// 模型宿主子进程（utilityProcess）：ONNX 推理、模型下载、内容提取全在这里跑。
// 即使推理 OOM 崩溃也只损失本进程，主应用无感。不得 require('electron') 主模块。
const os = require('os');
const vm = require('vm');
const { restrictedRequire } = require('../shared/restrictedRequire');

const MODELS_DIR = process.env.EPILOGUE_MODELS_DIR;
const MIRROR = process.env.EPILOGUE_HF_MIRROR || '';

const { createAggregator } = require('../shared/progressAggregate');

const pipelines = new Map();
const dlProgress = createAggregator();
let envApplied = false;

async function tf() {
  const m = await import('@huggingface/transformers');
  if (!envApplied) {
    m.env.cacheDir = MODELS_DIR;
    if (MIRROR) m.env.remoteHost = MIRROR;
    // 至少为系统保留一个核：numThreads ≤ min(2, cores-1)
    if (m.env.backends?.onnx?.wasm) m.env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(2, os.cpus().length - 1));
    envApplied = true;
  }
  return m;
}

function report(progress) {
  process.parentPort.postMessage({ progress });
}

// 子进程内不可用 log.js（依赖 electron app）→ 经父进程转写诊断日志
function hostlog(msg, extra) {
  try {
    process.parentPort.postMessage({ hostlog: { msg: String(msg), extra } });
  } catch {
    /* 父进程已退出 */
  }
}

// 文件级进度 → 聚合为整体进度；percent=null 表示尚有文件 total 未知（UI 显示字节+流动条）
function progressCallback(model) {
  return (p) => {
    if (p.status === 'initiate') {
      dlProgress.initiate(model, p.file);
    } else if (p.status === 'progress') {
      report(dlProgress.update(model, { file: p.file, loaded: p.loaded || 0, total: p.total || 0 }));
    }
  };
}

function progressDone(model) {
  const fin = dlProgress.done(model);
  if (fin.total) report(fin); // 实际发生过下载才收口 100%（纯缓存加载不上报）
}

async function getPipeline(task, model, options = {}) {
  const key = `${task}:${model}`;
  if (!pipelines.has(key)) {
    pipelines.set(
      key,
      (async () => {
        const { pipeline } = await tf();
        const pipe = await pipeline(task, model, {
          dtype: 'q8',
          device: 'cpu',
          // 关闭 ONNX 内存池：BFCArena 指数 Extend 正是 OOM 崩溃点（crash 2026-06-10）
          session_options: { enableCpuMemArena: false, enableMemPattern: false },
          ...options,
          progress_callback: progressCallback(model),
        });
        progressDone(model);
        return pipe;
      })().catch((e) => {
        pipelines.delete(key); // 失败不缓存，允许重试
        dlProgress.clear(model); // 聚合状态清零，重试从头算
        throw e;
      })
    );
  }
  return pipelines.get(key);
}

// 扩展 host 模块：由主进程在每次（重）启动后经 __register 下发，ops 与核心 handlers 并存
let moduleOps = {};
let ready = Promise.resolve();
let registerError = '';

function hostApi(packageDir) {
  return Object.freeze({
    transformers: tf,
    getPipeline,
    progress: Object.freeze({ callback: progressCallback, done: progressDone, clear: (model) => dlProgress.clear(model) }),
    report,
    log: hostlog,
    packageDir,
  });
}

async function registerModule(spec) {
  moduleOps = {};
  registerError = '';
  if (!spec || typeof spec.source !== 'string') return;
  const fn = vm.compileFunction(spec.source, ['exports', 'require', 'module'], { filename: spec.filename });
  const mod = { exports: {} };
  fn.call(mod.exports, mod.exports, restrictedRequire, mod);
  if (typeof mod.exports.activate !== 'function') throw new Error('host module has no activate()');
  const ops = await mod.exports.activate(hostApi(spec.packageDir));
  const table = {};
  for (const [name, op] of Object.entries(ops || {})) {
    if (typeof op !== 'function') throw new Error(`host op '${name}' is not a function`);
    if (Object.hasOwn(handlers, name)) throw new Error(`host op '${name}' is reserved`);
    table[name] = op;
  }
  moduleOps = table;
}

const handlers = {
  // 下载支持文件 = 构建一次 pipeline（进度聚合与 100% 收口在构建函数内）；
  // 扩展可用 download:<task> op 接管非 pipeline 任务（如 CLIP 双塔）的加载
  async download(task, model) {
    const custom = moduleOps[`download:${task}`];
    if (custom) await custom(model);
    else await getPipeline(task, model);
    return true;
  },
  // 仅从缓存剔除该模型的 pipeline（删除模型时子进程忙 → 不能重启打断他人下载，用这个代替）
  async unload(model) {
    for (const key of pipelines.keys()) {
      if (key.endsWith(`:${model}`)) pipelines.delete(key);
    }
    await moduleOps['unload:model']?.(model);
    return true;
  },
  async embed(texts, model) {
    const pipe = await getPipeline('feature-extraction', model);
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    return out.tolist();
  },
  // 内容提取（adm-zip 同步解析等重活）：在本子进程执行，主进程事件循环零阻塞
  async extract(filePath, opts) {
    const { extract } = require('./extractors'); // extractors 零 electron 依赖
    return extract(filePath, opts);
  },
};

process.parentPort.on('message', async (e) => {
  const { id, op, args } = e.data;
  if (op === '__register') {
    ready = registerModule(args[0]).catch((err) => {
      moduleOps = {};
      registerError = String((err && err.message) || err).slice(0, 300);
      hostlog('host module registration failed', { error: registerError });
    });
    return;
  }
  try {
    await ready;
    const handler = Object.hasOwn(handlers, op) ? handlers[op] : moduleOps[op];
    if (!handler) throw new Error(`unknown host op '${op}'${registerError ? ` (host module failed: ${registerError})` : ''}`);
    const result = await handler(...args);
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
