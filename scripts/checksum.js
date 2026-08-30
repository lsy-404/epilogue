'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeChecksum(filePath) {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.promises.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Release asset is not a file: ${absolutePath}`);

  const digest = await sha256(absolutePath);
  const checksumPath = `${absolutePath}.sha256`;
  await fs.promises.writeFile(checksumPath, `${digest} *${path.basename(absolutePath)}\n`, 'utf8');
  return { checksumPath, digest };
}

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/checksum.js <release-asset>');
    process.exitCode = 2;
  } else {
    writeChecksum(filePath)
      .then(({ checksumPath, digest }) => console.log(`${digest}  ${checksumPath}`))
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}

module.exports = { sha256, writeChecksum };
