'use strict';

function buildPaginationItems(currentPage, totalPages) {
  const current = Math.max(1, Math.min(Number(currentPage) || 1, Number(totalPages) || 1));
  const total = Math.max(0, Number(totalPages) || 0);
  if (total <= 1) return total === 1 ? [ 1 ] : [];
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([ 1, total, current - 2, current - 1, current, current + 1, current + 2 ]
    .filter(page => page >= 1 && page <= total));
  const sorted = [ ...pages ].sort((left, right) => left - right);
  const items = [];
  sorted.forEach((page, index) => {
    if (index && page - sorted[index - 1] > 1) items.push(`ellipsis-${page}`);
    items.push(page);
  });
  return items;
}

module.exports = { buildPaginationItems };
