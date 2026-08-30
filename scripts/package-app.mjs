import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listPackage, statFile } from '@electron/asar';
import { packager } from '@electron/packager';

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const SUPPORTED_ARCHES = new Set(['arm64', 'x64']);
const ORT_RELATIVE_ROOT = path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
export const NATIVE_BINARY_GLOB = '**/*.{node,dll,dylib,so,so.*}';

export function validateTarget(platform, arch) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!SUPPORTED_ARCHES.has(arch)) {
    throw new Error(`Unsupported architecture: ${arch}`);
  }
  return { platform, arch };
}

async function directoryNames(directory) {
  return (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function removeProviderLibraries(directory) {
  let removed = 0;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await removeProviderLibraries(entryPath);
    } else if (/^libonnxruntime_providers_(?:cuda|tensorrt)(?:\.|$)/.test(entry.name)) {
      await fs.promises.rm(entryPath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function verifyRuntimeDirectory(ortRoot, platform, arch) {
  const platforms = await directoryNames(ortRoot);
  const targetDirectory = path.join(ortRoot, platform, arch);

  if (!platforms.includes(platform)) {
    throw new Error(`onnxruntime-node does not contain ${platform}/${arch}`);
  }

  const arches = await directoryNames(path.join(ortRoot, platform));
  if (!arches.includes(arch)) {
    throw new Error(`onnxruntime-node does not contain ${platform}/${arch}`);
  }

  const targetFiles = await fs.promises.readdir(targetDirectory);
  if (!targetFiles.includes('onnxruntime_binding.node')) {
    throw new Error(`Missing onnxruntime_binding.node for ${platform}/${arch}`);
  }

  const hasRuntimeLibrary = targetFiles.some((file) => {
    if (platform === 'win32') return file === 'onnxruntime.dll';
    if (platform === 'darwin') return /^libonnxruntime(?:\..+)?\.dylib$/.test(file);
    return /^libonnxruntime\.so(?:\.|$)/.test(file);
  });
  if (!hasRuntimeLibrary) {
    throw new Error(`Missing ONNX Runtime shared library for ${platform}/${arch}`);
  }

  return { platforms, arches, targetDirectory };
}

export async function pruneOnnxRuntime(appDirectory, platform, arch) {
  validateTarget(platform, arch);
  const ortRoot = path.join(appDirectory, ORT_RELATIVE_ROOT);

  // Validate first so a changed dependency layout cannot silently produce a broken package.
  await verifyRuntimeDirectory(ortRoot, platform, arch);

  const removedPairs = [];
  for (const candidatePlatform of await directoryNames(ortRoot)) {
    if (candidatePlatform !== platform) {
      for (const candidateArch of await directoryNames(path.join(ortRoot, candidatePlatform))) {
        removedPairs.push(`${candidatePlatform}/${candidateArch}`);
      }
      await fs.promises.rm(path.join(ortRoot, candidatePlatform), { recursive: true, force: true });
    }
  }
  for (const candidateArch of await directoryNames(path.join(ortRoot, platform))) {
    if (candidateArch !== arch) {
      removedPairs.push(`${platform}/${candidateArch}`);
      await fs.promises.rm(path.join(ortRoot, platform, candidateArch), {
        recursive: true,
        force: true,
      });
    }
  }

  const removedProviders = await removeProviderLibraries(ortRoot);
  const result = await verifyRuntimeDirectory(ortRoot, platform, arch);
  if (result.platforms.length !== 1 || result.arches.length !== 1) {
    throw new Error(
      `ONNX Runtime pruning failed; found platforms=${result.platforms.join(',')} arches=${result.arches.join(',')}`,
    );
  }

  return { removedPairs: removedPairs.sort(), removedProviders };
}

function archivePathName(file) {
  return file.replaceAll('\\', '/').replace(/^\/+/, '');
}

export function verifyAsarOnnxRuntime(asarPath, platform, arch) {
  validateTarget(platform, arch);
  const prefix = 'node_modules/onnxruntime-node/bin/napi-v6/';
  const archivedFiles = listPackage(asarPath, { isPack: false });
  const files = archivedFiles.map(archivePathName);
  const pairs = new Set();

  for (const file of files) {
    const match = file.match(
      /^node_modules\/onnxruntime-node\/bin\/napi-v6\/([^/]+)\/([^/]+)(?:\/|$)/,
    );
    if (match) pairs.add(`${match[1]}/${match[2]}`);
  }

  const expectedPair = `${platform}/${arch}`;
  if (pairs.size !== 1 || !pairs.has(expectedPair)) {
    throw new Error(
      `Packaged ASAR has unexpected ONNX Runtime targets: ${[...pairs].sort().join(', ') || '(none)'}`,
    );
  }

  const binding = `${prefix}${expectedPair}/onnxruntime_binding.node`;
  if (!files.includes(binding)) {
    throw new Error(`Packaged ASAR is missing ${binding}`);
  }
  const forbiddenProvider = files.find((file) =>
    /libonnxruntime_providers_(?:cuda|tensorrt)(?:\.|$)/.test(file),
  );
  if (forbiddenProvider) {
    throw new Error(`Packaged ASAR contains unused provider library: ${forbiddenProvider}`);
  }

  // Native addons often load sibling shared libraries (sharp/libvips and ONNX
  // Runtime are both examples). Electron can temporarily extract a lone .node
  // file, but that does not preserve those sibling relationships. Require every
  // native binary to live in app.asar.unpacked instead.
  const nativeFiles = archivedFiles.filter((file) =>
    /(?:\.node|\.dll|\.dylib|\.so(?:\.|$))$/i.test(archivePathName(file)),
  );
  if (!nativeFiles.length) throw new Error('Packaged ASAR contains no native runtime files');
  for (const file of nativeFiles) {
    const lookupName = file.replace(/^[/\\]+/, '');
    if (!statFile(asarPath, lookupName).unpacked) {
      throw new Error(`Native runtime must be unpacked: ${archivePathName(file)}`);
    }
  }

  return { expectedPair, fileCount: files.length, nativeFileCount: nativeFiles.length };
}

export async function packageApp(platform, arch) {
  validateTarget(platform, arch);
  const root = path.resolve(import.meta.dirname, '..');
  const iconExtension = platform === 'darwin' ? 'icns' : platform === 'win32' ? 'ico' : 'png';
  const expectedOutput = path.join(root, 'dist', `Epilogue-${platform}-${arch}`);

  const outputPaths = await packager({
    dir: root,
    name: 'Epilogue',
    platform,
    arch,
    out: path.join(root, 'dist'),
    overwrite: true,
    icon: path.join(root, 'build', `icon.${iconExtension}`),
    asar: { unpackDir: 'build', unpack: NATIVE_BINARY_GLOB },
    ignore: [
      /^\/agents(?:\/|$)/,
      /^\/test(?:\/|$)/,
      /^\/dist(?:\/|$)/,
      /^\/\.git(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /node_modules\/onnxruntime-web(?:\/|$)/,
    ],
    afterPrune: [
      async ({ buildPath, platform: hookPlatform, arch: hookArch }) => {
        const result = await pruneOnnxRuntime(buildPath, hookPlatform, hookArch);
        console.log(
          `Pruned ONNX Runtime targets: ${result.removedPairs.join(', ') || '(none)'}; ` +
            `providers: ${result.removedProviders}`,
        );
      },
    ],
    afterAsar: [
      ({ buildPath, platform: hookPlatform, arch: hookArch }) => {
        const asarPath = path.join(path.dirname(buildPath), 'app.asar');
        const result = verifyAsarOnnxRuntime(asarPath, hookPlatform, hookArch);
        console.log(`Verified app.asar contains only ONNX Runtime ${result.expectedPair}`);
      },
    ],
  });

  if (outputPaths.length !== 1 || path.resolve(outputPaths[0]) !== path.resolve(expectedOutput)) {
    throw new Error(`Unexpected package output: ${outputPaths.join(', ')}`);
  }
  return expectedOutput;
}

async function main() {
  const platform = process.argv[2] || 'darwin';
  const arch = process.argv[3] || 'arm64';
  const output = await packageApp(platform, arch);
  console.log(`Packaged ${output}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
