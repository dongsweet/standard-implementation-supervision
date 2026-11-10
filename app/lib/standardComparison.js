'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseDelimitedRows, parseStandardImportFile, parseStandardRows } = require('./standardImport');

async function parseComparisonFile(filePath, fileName) {
  const extension = path.extname(fileName || filePath).toLowerCase();
  if ([ '.xlsx', '.tsv' ].includes(extension)) {
    return parseStandardImportFile(filePath, fileName);
  }
  if ([ '.csv', '.txt' ].includes(extension)) {
    const text = await fs.readFile(filePath, 'utf8');
    const delimiter = extension === '.csv' || text.includes(',') && !text.includes('\t') ? ',' : '\t';
    return parseStandardRows([ {
      name: path.basename(fileName || filePath),
      rows: parseDelimitedRows(text, delimiter),
    } ]);
  }
  throw Object.assign(new Error('对照文件支持 .xlsx、.tsv、.csv 或制表符分隔的 .txt'), { status: 400 });
}

function normalizeNumber(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[：:]/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。；：、,.!?！？;:'"“”‘’()（）\[\]【】《》<>—_-]/g, '');
}

function grams(text, size = 3) {
  const chars = [ ...text ];
  if (chars.length < size) return new Set(chars);
  const result = new Set();
  for (let index = 0; index <= chars.length - size; index += 1) {
    result.add(chars.slice(index, index + size).join(''));
  }
  return result;
}

function diceSimilarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aGrams = grams(a);
  const bGrams = grams(b);
  let overlap = 0;
  for (const value of aGrams) if (bGrams.has(value)) overlap += 1;
  return (2 * overlap) / (aGrams.size + bGrams.size);
}

function comparisonRows(parsed) {
  return parsed.chapters.flatMap(chapter => chapter.items.map((item, index) => ({
    chapterCode: chapter.code,
    chapterName: chapter.name,
    itemCode: item.itemCode,
    internalSequence: index + 1,
    title: item.title || '',
    content: item.content || '',
  })));
}

function chapterKey(value) {
  const match = String(value || '').normalize('NFKC').match(/^(\d{1,3}(?:\.\d{1,3}){0,3})/);
  return match ? match[1] : normalizeNumber(value);
}

function rootChapterKey(value) {
  const key = chapterKey(value);
  const numeric = key.match(/^(\d{1,3})(?:\.|$)/);
  return numeric ? numeric[1] : key;
}

function nodeChapterCode(node, byId) {
  const headings = [];
  let parentId = node.parentId;
  const visited = new Set();
  while (parentId && byId.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (parent.kind === 'heading') headings.push(parent);
    parentId = parent.parentId;
  }
  if (node.kind === 'heading') headings.unshift(node);
  return headings.find(item => item.level === 1)?.originalNumber
    || headings[headings.length - 1]?.originalNumber
    || '';
}

function alignSequence(nodes, rows) {
  const n = nodes.length;
  const m = rows.length;
  const gap = -0.12;
  const minimumScore = 0.45;
  const scores = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  const choices = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
  for (let i = 1; i <= n; i += 1) {
    scores[i][0] = i * gap;
    choices[i][0] = { choice: 'up' };
  }
  for (let j = 1; j <= m; j += 1) {
    scores[0][j] = j * gap;
    choices[0][j] = { choice: 'left' };
  }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const similarity = diceSimilarity(nodes[i - 1].content, rows[j - 1].content);
      const pairScore = similarity >= 0.45 ? similarity : -1.5;
      const candidates = [
        { score: scores[i - 1][j - 1] + pairScore, choice: 'diag', similarity },
        { score: scores[i - 1][j] + gap, choice: 'up', similarity: 0 },
        { score: scores[i][j - 1] + gap, choice: 'left', similarity: 0 },
      ].sort((left, right) => right.score - left.score);
      scores[i][j] = candidates[0].score;
      choices[i][j] = candidates[0];
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i === 0) {
      j -= 1;
      continue;
    }
    if (j === 0) {
      i -= 1;
      continue;
    }
    const choice = choices[i][j];
    if (choice?.choice === 'diag' && choice.similarity >= minimumScore) {
      pairs.push({ node: nodes[i - 1], row: rows[j - 1], similarity: choice.similarity });
      i -= 1;
      j -= 1;
    } else if (choice?.choice === 'left') {
      j -= 1;
    } else {
      i -= 1;
    }
  }
  return pairs.reverse();
}

function mergeComparisonIntoTree(tree, parsed) {
  const rows = comparisonRows(parsed);
  const nodes = tree.nodes || [];
  const byId = new Map(nodes.map(node => [ node.id, node ]));
  const usedRows = new Set();
  const matchedNodeIds = new Set();
  const matches = [];

  const assign = (node, row, method, similarity) => {
    if (!node || !row || usedRows.has(row) || matchedNodeIds.has(node.id)) return;
    usedRows.add(row);
    matchedNodeIds.add(node.id);
    const sameContent = normalizeText(node.content) === normalizeText(row.content);
    const highConfidence = sameContent || similarity >= 0.9;
    const status = highConfidence ? 'matched' : similarity >= 0.45 ? 'review' : 'unmatched';
    node.ocrContent = node.ocrContent ?? node.content;
    node.comparisonContent = row.content;
    node.comparisonItemCode = row.itemCode;
    node.comparisonChapterCode = row.chapterCode;
    node.comparisonChapterName = row.chapterName;
    node.comparisonTitle = row.title;
    node.comparisonSimilarity = Math.round(similarity * 1000) / 1000;
    node.comparisonMatch = status;
    node.comparisonMethod = method;
    if (highConfidence) {
      node.content = row.content;
      if (!node.title && row.title) node.title = row.title;
      node.contentSource = 'comparison';
    }
    matches.push({ nodeId: node.id, row, method, similarity, status });
  };

  const itemNodes = nodes.filter(node => (node.kind === 'list' || node.kind === 'heading') && normalizeText(node.content));
  const nodesByChapter = new Map();
  for (const node of itemNodes) {
    const key = rootChapterKey(nodeChapterCode(node, byId));
    if (!nodesByChapter.has(key)) nodesByChapter.set(key, []);
    nodesByChapter.get(key).push(node);
  }

  const pdfChapterTitles = new Map();
  for (const node of nodes.filter(item => item.kind === 'heading' && item.level === 1)) {
    pdfChapterTitles.set(rootChapterKey(node.originalNumber), node.title || '');
  }

  const rowChapterGroups = new Map();
  for (const row of rows) {
    const key = rootChapterKey(row.chapterCode);
    if (!rowChapterGroups.has(key)) rowChapterGroups.set(key, { key, chapterName: row.chapterName || '', rows: [] });
    rowChapterGroups.get(key).rows.push(row);
  }

  const rowsByChapter = new Map();
  for (const group of rowChapterGroups.values()) {
    let key = group.key;
    if (!nodesByChapter.has(key)) {
      let bestKey = null;
      let bestScore = 0;
      for (const [ pdfKey, title ] of pdfChapterTitles) {
        const score = diceSimilarity(group.chapterName, title);
        if (score > bestScore) {
          bestKey = pdfKey;
          bestScore = score;
        }
      }
      if (!bestKey || bestScore < 0.55) continue;
      key = bestKey;
    }
    if (!rowsByChapter.has(key)) rowsByChapter.set(key, []);
    rowsByChapter.get(key).push(...group.rows);
  }

  for (const [ key, chapterNodes ] of nodesByChapter) {
    const chapterRows = rowsByChapter.get(key) || [];
    if (!chapterRows.length) continue;
    for (const pair of alignSequence(chapterNodes, chapterRows)) {
      if (pair.similarity >= 0.82) assign(pair.node, pair.row, 'sequence', pair.similarity);
    }
  }

  // OCR and the internal workbook often group clauses at different granularity.
  // Use a one-to-one global best match only as a suggestion when chapter sequence
  // alone is not enough. Low-confidence candidates never overwrite OCR text.
  const unmatchedNodes = itemNodes.filter(node => !matchedNodeIds.has(node.id));
  const availableRows = rows.filter(row => !usedRows.has(row));
  const candidates = [];
  for (const node of unmatchedNodes) {
    for (const row of availableRows) {
      const similarity = diceSimilarity(node.content, row.content);
      if (similarity >= 0.35) candidates.push({ node, row, similarity });
    }
  }
  candidates.sort((left, right) => right.similarity - left.similarity);
  for (const candidate of candidates) {
    if (matchedNodeIds.has(candidate.node.id) || usedRows.has(candidate.row)) continue;
    assign(candidate.node, candidate.row, 'content', candidate.similarity);
  }

  const summary = {
    comparisonCount: rows.length,
    matchedCount: matches.filter(item => item.status === 'matched').length,
    reviewCount: matches.filter(item => item.status === 'review').length,
    unmatchedCount: itemNodes.filter(node => !matchedNodeIds.has(node.id)).length,
    unusedComparisonCount: rows.length - usedRows.size,
    internalNumbering: true,
  };
  tree.comparisonSummary = summary;
  tree.comparisonMatchedNodes = matchedNodeIds.size;
  tree.warnings = [
    `已按章节顺序和正文相似度加载对照表：${summary.comparisonCount} 条；高可信采用 ${summary.matchedCount} 条，需要核对 ${summary.reviewCount} 条。内部编号不会覆盖PDF原文编号。`,
    ...(tree.warnings || []),
  ];
  return summary;
}

module.exports = {
  comparisonRows,
  diceSimilarity,
  mergeComparisonIntoTree,
  normalizeNumber,
  normalizeText,
  parseComparisonFile,
};
