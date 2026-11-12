'use strict';

function numberPrefix(value) {
  const source = String(value || '').normalize('NFKC').trim().toUpperCase();
  const matches = source.match(/\d+/g);
  const candidate = matches?.at(-1) || source;
  return candidate.replace(/[^0-9A-Z]+/g, '-').replace(/^-+|-+$/g, '') || 'STANDARD';
}

function chapterPart(value) {
  return String(value || '').normalize('NFKC').trim()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'CHAPTER';
}

function formatOrder(value) {
  return String(Math.max(1, Number.parseInt(value, 10) || 1)).padStart(4, '0');
}

function chapterStandardNumber(standardCode, chapterCode) {
  return `${numberPrefix(standardCode)}-${chapterPart(chapterCode)}`;
}

function itemStandardNumber(standardCode, chapterCode, importOrder) {
  return `${chapterStandardNumber(standardCode, chapterCode)}-${formatOrder(importOrder)}`;
}

module.exports = {
  chapterStandardNumber,
  itemStandardNumber,
  numberPrefix,
  chapterPart,
};
