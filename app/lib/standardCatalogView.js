'use strict';

const CHAPTER_PAGE_SIZES = new Set([ '1', '2', '5', '10', '20', 'all' ]);

function normalizeSearchText(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
}

function hasAssignmentPlaceholder(item) {
  const content = normalizeSearchText(item.content);
  const explanation = normalizeSearchText(item.explanation);
  return /[\[【]\s*[赋賦]值/u.test(`${content}\n${explanation}`);
}

function itemMatchesSearch(item, chapter, search) {
  if (!search) return true;
  const headingText = Array.isArray(item.headingPath)
    ? item.headingPath.map(heading => `${heading.number || ''} ${heading.title || ''}`).join('\n')
    : '';
  const searchableText = [
    chapter.code,
    chapter.name,
    item.standardNumber,
    item.itemCode,
    item.title,
    item.explanation,
    item.content,
    headingText,
  ].map(normalizeSearchText).join('\n');
  return searchableText.includes(search);
}

function filterChapters(chapters, { search = '', needsAssignment = false, chapterCode = '' } = {}) {
  const normalizedSearch = normalizeSearchText(search);
  const normalizedChapterCode = normalizeSearchText(chapterCode);
  const shouldHideEmpty = Boolean(normalizedSearch || needsAssignment || normalizedChapterCode);
  return chapters.flatMap(chapter => {
    if (normalizedChapterCode && normalizeSearchText(chapter.code) !== normalizedChapterCode) return [];
    const items = (chapter.items || [])
      .map(item => ({ ...item, requiresAssignment: hasAssignmentPlaceholder(item) }))
      .filter(item =>
        (!needsAssignment || item.requiresAssignment) && itemMatchesSearch(item, chapter, normalizedSearch)
      );
    if (shouldHideEmpty && !items.length) return [];
    return [{ ...chapter, items, item_count: items.length }];
  });
}

function getPage(value) {
  return Math.max(1, Number.parseInt(value, 10) || 1);
}

function paginateChapters(chapters, requestedPage, pageSizeValue) {
  const pageSize = CHAPTER_PAGE_SIZES.has(String(pageSizeValue)) ? String(pageSizeValue) : '1';
  const numericPageSize = pageSize === 'all' ? Math.max(1, chapters.length) : Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(chapters.length / numericPageSize));
  const page = Math.min(pageCount, getPage(requestedPage));
  const start = (page - 1) * numericPageSize;
  return {
    chapters: chapters.slice(start, start + numericPageSize),
    pagination: {
      page,
      pageCount,
      pageSize,
      firstChapter: chapters.length ? start + 1 : 0,
      lastChapter: Math.min(start + numericPageSize, chapters.length),
      total: chapters.length,
    },
  };
}

module.exports = {
  filterChapters,
  hasAssignmentPlaceholder,
  itemMatchesSearch,
  paginateChapters,
};
