'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { extract } = require('../src/main/extractors');

function minimalPdf(text) {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${text.replace(/[\\()]/g, '\\$&')}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('Office extraction supports the officeparser v6 AST API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-office-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hello.docx');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>Hello from Epilogue</w:t></w:r></w:p></w:body>
    </w:document>`));
  zip.writeZip(file);

  const result = await extract(file, { maxChars: 1000 });
  assert.equal(result.kind, 'office');
  assert.match(result.content, /Hello from Epilogue/);
});

test('Archive extraction supports adm-zip 0.6 and reads bounded inline text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notes.zip');
  const zip = new AdmZip();
  zip.addFile('notes/readme.txt', Buffer.from('Safe archive extraction'));
  zip.writeZip(file);

  const result = await extract(file, { maxChars: 1000 });
  assert.equal(result.kind, 'archive');
  assert.match(result.content, /notes\/readme\.txt/);
  assert.match(result.content, /Safe archive extraction/);
});

test('PDF extraction uses the fixed PDF.js path with dynamic evaluation disabled', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-pdf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hello.pdf');
  fs.writeFileSync(file, minimalPdf('Hello from secure PDF.js'));

  const result = await extract(file, { maxChars: 1000, pdfMaxPages: 1 });
  assert.equal(result.kind, 'pdf');
  assert.match(result.content, /Hello from secure PDF\.js/);
});
