'use strict';

function numberPrefix(value) {
  const source = String(value || '').normalize('NFKC').trim().toUpperCase();
  const matches = source.match(/\d+/g);
  const candidate = matches?.at(-1) || source;
  return candidate.replace(/[^0-9A-Z]+/g, '-').replace(/^-+|-+$/g, '') || 'STANDARD';
}

function versionPart(value) {
  const source = String(value || '').normalize('NFKC').trim().toUpperCase();
  return source.replace(/[^0-9A-Z]+/g, '-').replace(/^-+|-+$/g, '') || 'VERSION';
}

function chapterPart(value) {
  return String(value || '').normalize('NFKC').trim()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'CHAPTER';
}

function topLevelChapterCode(value) {
  const source = String(value || '').normalize('NFKC').trim();
  const numeric = source.match(/^(\d+)/);
  if (numeric) return numeric[1];
  const part = chapterPart(source);
  return part.split(/[._-]/, 1)[0] || 'C';
}

function formatOrder(value, width = 3) {
  return String(Math.max(1, Number.parseInt(value, 10) || 1)).padStart(width, '0');
}

function chapterNumberPart(chapterCode, width = 2) {
  const root = topLevelChapterCode(chapterCode);
  return /^\d+$/.test(root) ? root.padStart(width, '0') : root;
}

function chapterStandardNumber(standardCode, version, chapterCode, options = {}) {
  return `${numberPrefix(standardCode)}-${versionPart(version)}-${chapterNumberPart(chapterCode, options.chapterWidth || 2)}`;
}

function itemStandardNumber(standardCode, version, chapterCode, importOrder, options = {}) {
  const chapterNumber = chapterStandardNumber(standardCode, version, chapterCode, options);
  return `${chapterNumber}${formatOrder(importOrder, options.itemWidth || 3)}`;
}

function numberingWidths(chapters, items) {
  const chapterRoots = (chapters || []).map(chapter => topLevelChapterCode(chapter.code || chapter.chapterCode));
  const counts = new Map();
  for (const item of items || []) {
    const root = topLevelChapterCode(item.chapterCode || item.code);
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  const maxChapter = chapterRoots.reduce((max, value) => Math.max(max, /^\d+$/.test(value) ? Number(value) : 0), 0);
  const maxItems = Math.max(0, ...counts.values());
  return {
    chapterWidth: Math.max(2, String(maxChapter || 0).length),
    itemWidth: Math.max(3, String(maxItems || 0).length),
  };
}

async function recalculateStandardNumbers(client, versionId) {
  const versionResult = await client.query(`
    SELECT sv.version, s.code AS standard_code
    FROM standard_versions sv JOIN standards s ON s.id = sv.standard_id
    WHERE sv.id = $1`, [ versionId ]);
  if (!versionResult.rowCount) return null;
  const chaptersResult = await client.query(`
    SELECT id, code, sort_order
    FROM standard_chapters
    WHERE standard_version_id = $1
    ORDER BY sort_order, code, id`, [ versionId ]);
  const itemsResult = await client.query(`
    SELECT si.id, si.chapter_id, si.item_code, si.import_order, sc.code AS chapter_code, sc.sort_order
    FROM standard_items si JOIN standard_chapters sc ON sc.id = si.chapter_id
    WHERE si.standard_version_id = $1
    ORDER BY sc.sort_order, sc.code, si.import_order, si.item_code, si.id`, [ versionId ]);
  const widths = numberingWidths(chaptersResult.rows, itemsResult.rows);
  const groups = new Map();
  for (const item of itemsResult.rows) {
    const root = topLevelChapterCode(item.chapter_code);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  }
  for (const chapter of chaptersResult.rows) {
    await client.query(`UPDATE standard_chapters SET standard_number = $2 WHERE id = $1`, [
      chapter.id,
      chapterStandardNumber(versionResult.rows[0].standard_code, versionResult.rows[0].version, chapter.code, widths),
    ]);
  }
  await client.query(`
    UPDATE standard_items
    SET standard_number = 'TEMP-' || id::text
    WHERE standard_version_id = $1`, [ versionId ]);
  for (const items of groups.values()) {
    for (const [ index, item ] of items.entries()) {
      await client.query(`
        UPDATE standard_items
        SET import_order = $2, standard_number = $3
        WHERE id = $1`, [
        item.id,
        index + 1,
        itemStandardNumber(versionResult.rows[0].standard_code, versionResult.rows[0].version, item.chapter_code, index + 1, widths),
      ]);
    }
  }
  return widths;
}

module.exports = {
  chapterStandardNumber,
  itemStandardNumber,
  numberPrefix,
  chapterPart,
  versionPart,
  topLevelChapterCode,
  numberingWidths,
  recalculateStandardNumbers,
};
