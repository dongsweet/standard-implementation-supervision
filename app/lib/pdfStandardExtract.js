'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DEFAULT_DPI = 120;
const MAX_PAGES = 300;
const DEFAULT_CONCURRENCY = 4;
const MAX_BUFFER = 64 * 1024 * 1024;

async function command(name, args, options = {}) {
  const result = await execFileAsync(name, args, {
    maxBuffer: MAX_BUFFER,
    timeout: options.timeout || 120000,
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  return result.stdout;
}

async function inspectPdf(filePath, maxPages = MAX_PAGES) {
  const output = await command('pdfinfo', [ filePath ]);
  const pages = Number((output.match(/^Pages:\s+(\d+)/m) || [])[1]);
  if (!Number.isInteger(pages) || pages < 1) throw new Error('无法识别PDF页数');
  if (pages > maxPages) throw new Error(`PDF最多支持${maxPages}页`);
  return { pageCount: pages };
}

function joinOcrWords(words) {
  return words.reduce((text, word, index) => {
    if (!index) return word.word;
    const previous = words[index - 1].word;
    const separator = /[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]/.test(word.word) ? ' ' : '';
    return text + separator + word.word;
  }, '');
}

function parseTsv(text, page) {
  const rows = String(text || '').split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return { page, lines: [], height: 0 };
  const headers = rows[0].split('\t');
  const index = Object.fromEntries(headers.map((header, i) => [ header, i ]));
  const grouped = new Map();
  let pageHeight = 0;
  let pageWidth = 0;
  for (const row of rows.slice(1)) {
    const cols = row.split('\t');
    const word = (cols[index.text] || '').trim();
    pageWidth = Math.max(pageWidth, Number(cols[index.left] || 0) + Number(cols[index.width] || 0));
    if (!word) continue;
    const key = [ cols[index.block_num], cols[index.par_num], cols[index.line_num] ].join(':');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      word,
      left: Number(cols[index.left] || 0),
      top: Number(cols[index.top] || 0),
      width: Number(cols[index.width] || 0),
      height: Number(cols[index.height] || 0),
      confidence: Number(cols[index.conf] || 0),
    });
    pageHeight = Math.max(pageHeight, Number(cols[index.top] || 0) + Number(cols[index.height] || 0));
  }
  const lines = [ ...grouped.values() ].map(words => {
    words.sort((a, b) => a.left - b.left);
    const confidence = words.reduce((sum, word) => sum + Math.max(0, word.confidence), 0) / words.length;
    return {
      page,
      text: joinOcrWords(words),
      left: Math.min(...words.map(word => word.left)),
      top: Math.min(...words.map(word => word.top)),
      width: Math.max(...words.map(word => word.left + word.width)) - Math.min(...words.map(word => word.left)),
      height: Math.max(...words.map(word => word.height)),
      confidence: Math.round(confidence * 10) / 10,
      pageHeight,
      pageWidth,
    };
  }).filter(line => line.confidence >= 20).sort((a, b) => a.top - b.top || a.left - b.left);
  return { page, lines, height: pageHeight, width: pageWidth };
}

function joinCjkSpaces(text) {
  return String(text || '').replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1');
}

function cleanLine(text) {
  return joinCjkSpaces(String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' '))
    .replace(/\s+$/g, '')
    .trim();
}

function isHeaderOrFooter(line) {
  const text = cleanLine(line.text);
  if (!text) return true;
  if (/^GB\/T\s*\d{4,5}[—-]\d{4}$/i.test(text)) return true;
  if (/^(?:[IVXLCDM]+|\d{1,3})$/i.test(text) && line.pageHeight && line.top > line.pageHeight * 0.88) return true;
  if (/(?:\.{3,}|…{2,})\s*\d{1,3}$/.test(text)) return true;
  return false;
}

function heading(text) {
  const match = cleanLine(text).match(/^(\d{1,3}(?:\.\d{1,3}){0,3})\s*["'*“”]?\s*(\p{L}.*)$/u);
  if (!match) return null;
  const number = match[1];
  const title = match[2].trim();
  const level = number.split('.').length;
  if (level > 3 || title.length < 2) return null;
  if (/^[a-z][）)]/i.test(title)) return null;
  if (/^(?:天|年|个月|月|日|小时|分钟|秒|次|项|个|台|人)$/.test(title)) return null;
  return { kind: 'heading', number, title, level };
}

function listItem(text) {
  const value = cleanLine(text);
  let match = value.match(/^([a-zA-Z])\s*[）)_]\s*["'*“”]?\s*(\p{L}.*)$/u);
  if (match) return { kind: 'list', marker: `${match[1].toLowerCase()})`, body: match[2].trim(), markerType: 'letter', markerIndex: match[1].toLowerCase() };
  match = value.match(/^[（(](\d{1,3})[）)]\s*(.+)$/);
  if (match) return { kind: 'list', marker: `(${match[1]})`, body: match[2].trim(), markerType: 'number', markerIndex: Number(match[1]) };
  return null;
}

function defaultSkipped(node) {
  if (node.kind !== 'heading') return false;
  if (node.level !== 1) return false;
  return /^(前言|引言|目次|目\s*录|参考文献)$/.test(node.title || '');
}

function buildStandardTree(pages) {
  const nodes = [];
  const stack = [];
  let current = null;
  let nodeNumber = 0;
  const hasChapterOne = pages.some(page => (page.lines || []).some(raw => {
    const match = heading(raw.text);
    return match?.number === '1' && match.title === '范围';
  }));
  let started = !hasChapterOne;
  const lastLetterMarker = new Map();

  for (const page of pages) {
    for (const raw of page.lines) {
      if (isHeaderOrFooter(raw)) continue;
      const text = cleanLine(raw.text);
      if (!text) continue;

      const headingMatch = raw.left <= (page.width || Infinity) * 0.28 ? heading(text) : null;
      if (headingMatch) {
        if (!started && !(headingMatch.number === '1' && headingMatch.title === '范围')) continue;
        if (!started) started = true;
        nodeNumber += 1;
        const node = {
          id: `n${nodeNumber}`,
          kind: 'heading',
          level: headingMatch.level,
          originalNumber: headingMatch.number,
          headingNumber: headingMatch.number,
          title: headingMatch.title,
          content: '',
          parentId: null,
          pageFrom: page.page,
          pageTo: page.page,
          confidence: raw.confidence,
          role: 'container',
        };
        while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
        if (stack.length) node.parentId = stack[stack.length - 1].id;
        node.role = defaultSkipped(node) ? 'skip' : 'container';
        stack.push(node);
        nodes.push(node);
        current = node;
        continue;
      }

      const listMatch = listItem(text);
      if (listMatch && started) {
        const parent = stack.length ? stack[stack.length - 1] : current;
        const markerKey = parent ? parent.id : 'root';
        let marker = listMatch.marker;
        if (listMatch.markerType === 'letter') {
          const expectedCode = (lastLetterMarker.get(markerKey) || 96) + 1;
          const expected = expectedCode <= 122 ? String.fromCharCode(expectedCode) : '';
          if (marker !== `${expected})` && [ 'o)', '0)' ].includes(marker)) marker = `${expected})`;
          lastLetterMarker.set(markerKey, marker.charCodeAt(0));
        }
        nodeNumber += 1;
        const composite = parent && parent.headingNumber
          ? `${parent.headingNumber} ${marker}`
          : marker;
        const node = {
          id: `n${nodeNumber}`,
          kind: 'list',
          level: parent ? parent.level + 1 : 1,
          originalNumber: composite,
          headingNumber: parent ? parent.headingNumber : null,
          title: '',
          content: listMatch.body,
          parentId: parent ? parent.id : null,
          pageFrom: page.page,
          pageTo: page.page,
          confidence: raw.confidence,
          role: 'item',
        };
        nodes.push(node);
        current = node;
        continue;
      }

      if (!started) continue;
      if (/^附录\s*[A-Z]/i.test(text) || /^参考文献$/.test(text)) {
        nodeNumber += 1;
        const node = {
          id: `n${nodeNumber}`,
          kind: 'heading',
          level: 1,
          originalNumber: '',
          headingNumber: '',
          title: text,
          content: '',
          parentId: null,
          pageFrom: page.page,
          pageTo: page.page,
          confidence: raw.confidence,
          role: 'skip',
        };
        stack.length = 0;
        nodes.push(node);
        current = node;
        continue;
      }
      if (current) {
        current.content = current.content
          ? `${current.content}\n${text}`
          : text;
        current.pageTo = page.page;
        current.confidence = Math.min(current.confidence, raw.confidence);
      }
    }
  }

  const useful = nodes.filter(node => !/^附录\s*[A-Z]/i.test(node.title || '') && node.title !== '参考文献');
  return {
    pages: pages.length,
    nodes: useful,
    warnings: [
      'OCR结果必须人工核对，尤其是编号、跨页续文和扫描模糊处。',
      '默认跳过前言、引言、附录和参考文献；请在预览树中确认。',
    ],
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
      completed += 1;
      await worker.progress?.(completed, items.length, results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function ocrPdf(filePath, options = {}, onProgress = () => {}) {
  const { pageCount } = await inspectPdf(filePath, Number(options.maxPages || MAX_PAGES));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'standard-pdf-'));
  const dpi = Math.max(100, Math.min(Number(options.dpi || DEFAULT_DPI), 220));
  const lang = options.lang || 'chi_sim+eng';
  const concurrency = Math.max(1, Math.min(Number(options.concurrency || DEFAULT_CONCURRENCY), 8));
  try {
    await command('pdftoppm', [ '-r', String(dpi), '-jpeg', '-jpegopt', 'quality=85', filePath, path.join(directory, 'page') ], {
      timeout: Math.max(120000, pageCount * 10000),
    });
    const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
    const worker = async page => {
      const prefix = path.join(directory, `page-${String(page).padStart(pageCount >= 1000 ? 4 : 3, '0')}`);
      const tsv = await command('tesseract', [ `${prefix}.jpg`, 'stdout', '-l', lang, '--psm', '6', 'tsv' ], {
        timeout: 180000,
        env: { OMP_THREAD_LIMIT: '1' },
      });
      return parseTsv(tsv, page);
    };
    worker.progress = async (completed, total) => onProgress(completed, total);
    const pages = await mapWithConcurrency(pageNumbers, concurrency, worker);
    pages.sort((left, right) => left.page - right.page);
    return { tree: buildStandardTree(pages), pageCount };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = {
  buildStandardTree,
  inspectPdf,
  mapWithConcurrency,
  ocrPdf,
  parseTsv,
};
