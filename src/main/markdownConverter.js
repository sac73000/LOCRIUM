/**
 * LOCRIUM — Markdown Converter
 *
 * Converts PDF, DOCX, XLSX, HTML, and TXT files to Markdown.
 * Runs entirely in the Electron main process — no network calls, no cloud.
 *
 * Supported formats:
 *   .docx  → mammoth  (preserves headings, bold, lists, tables)
 *   .pdf   → pdf-parse (text extraction; encrypted PDFs fail gracefully)
 *   .xlsx  → xlsx     (each sheet → Markdown table)
 *   .html  → turndown (converts HTML tags to Markdown)
 *   .txt   → identity  (returned as-is)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Output directory ──────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(os.homedir(), 'Downloads', 'LocriumMarkdown');

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ── Per-format converters ─────────────────────────────────────────────────────

async function convertDocx(filePath) {
  const mammoth = require('mammoth');
  const result  = await mammoth.convertToMarkdown({ path: filePath });
  return result.value || '';
}

async function convertPdf(filePath) {
  const pdfParse = require('pdf-parse');
  const buffer   = fs.readFileSync(filePath);
  const data     = await pdfParse(buffer);
  // pdf-parse returns raw text; wrap paragraphs in simple Markdown
  const lines = data.text.split('\n');
  const mdLines = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) { mdLines.push(''); continue; }
    // Very short lines at start of a group are likely headings
    mdLines.push(trimmed);
  }
  return mdLines.join('\n');
}

function convertXlsx(filePath) {
  const XLSX   = require('xlsx');
  const wb     = XLSX.readFile(filePath);
  const parts  = [];

  for (const sheetName of wb.SheetNames) {
    const ws    = wb.Sheets[sheetName];
    const rows  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) continue;

    parts.push(`## ${sheetName}\n`);

    // Build Markdown table from rows
    const colWidths = [];
    for (const row of rows) {
      for (let c = 0; c < row.length; c++) {
        const w = String(row[c] || '').length;
        colWidths[c] = Math.max(colWidths[c] || 3, w);
      }
    }

    const pad = (val, width) => {
      const s = String(val || '');
      return s + ' '.repeat(Math.max(0, width - s.length));
    };

    const [header, ...dataRows] = rows;
    if (!header || !header.length) continue;

    const headerLine = '| ' + header.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';
    const sepLine    = '| ' + colWidths.slice(0, header.length).map((w) => '-'.repeat(w)).join(' | ') + ' |';
    const dataLines  = dataRows.map(
      (row) => '| ' + header.map((_, i) => pad(row[i], colWidths[i])).join(' | ') + ' |'
    );

    parts.push([headerLine, sepLine, ...dataLines].join('\n'));
    parts.push('');
  }

  return parts.join('\n');
}

function convertHtml(filePath) {
  const TurndownService = require('turndown');
  const html = fs.readFileSync(filePath, 'utf8');
  const td   = new TurndownService({
    headingStyle:  'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  return td.turndown(html);
}

function convertTxt(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// ── Main dispatch ─────────────────────────────────────────────────────────────

/**
 * Convert a single file to Markdown.
 * @param {string} filePath  Absolute path to the source file.
 * @returns {{ success: boolean, markdown: string, error: string|null, outputPath: string|null }}
 */
async function convertFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const SUPPORTED = ['.docx', '.pdf', '.xlsx', '.html', '.htm', '.txt'];
  if (!SUPPORTED.includes(ext)) {
    return { success: false, markdown: '', error: `Unsupported format: ${ext}`, outputPath: null };
  }

  let markdown = '';
  try {
    switch (ext) {
      case '.docx':          markdown = await convertDocx(filePath); break;
      case '.pdf':           markdown = await convertPdf(filePath);  break;
      case '.xlsx':          markdown = convertXlsx(filePath);       break;
      case '.html':
      case '.htm':           markdown = convertHtml(filePath);       break;
      case '.txt':           markdown = convertTxt(filePath);        break;
    }
  } catch (err) {
    let msg = err.message || String(err);
    if (msg.includes('encrypted') || msg.includes('password')) {
      msg = 'Could not parse PDF — file may be encrypted or password-protected';
    }
    return { success: false, markdown: '', error: msg, outputPath: null };
  }

  // Write output — collision-safe (appends -1, -2, … if name already exists)
  try {
    ensureOutputDir();
    const baseName = path.basename(filePath, ext);
    let outputPath = path.join(OUTPUT_DIR, `${baseName}.md`);
    let suffix = 1;
    while (fs.existsSync(outputPath)) {
      outputPath = path.join(OUTPUT_DIR, `${baseName}-${suffix}.md`);
      suffix += 1;
    }
    fs.writeFileSync(outputPath, markdown, 'utf8');
    return { success: true, markdown, error: null, outputPath };
  } catch (writeErr) {
    return { success: false, markdown, error: `Failed to write output: ${writeErr.message}`, outputPath: null };
  }
}

/**
 * Combine multiple Markdown strings into one and write to combined.md.
 * @param {Array<{ name: string, markdown: string }>} items
 * @returns {{ success: boolean, outputPath: string|null, error: string|null }}
 */
function writeCombined(items) {
  try {
    ensureOutputDir();
    const sections = items.map(({ name, markdown }) => `# ${name}\n\n${markdown}`);
    const combined = sections.join('\n\n---\n\n');
    const outputPath = path.join(OUTPUT_DIR, 'combined.md');
    fs.writeFileSync(outputPath, combined, 'utf8');
    return { success: true, outputPath, error: null };
  } catch (err) {
    return { success: false, outputPath: null, error: err.message };
  }
}

module.exports = {
  convertFile,
  writeCombined,
  OUTPUT_DIR,
};
