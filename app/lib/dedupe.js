'use strict';

const crypto = require('node:crypto');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[，。；：、（）【】《》“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDefinition(definition) {
  const fields = [ 'object_name', 'object_category', 'check_layer', 'check_method', 'description', 'steps', 'frequency' ];
  const values = Object.fromEntries(fields.map(field => [ field, normalizeText(definition[field]) ]));
  return { ...values, normalizedHash: crypto.createHash('sha256').update(fields.map(field => values[field]).join('|')).digest('hex') };
}

function trigrams(value) {
  const text = `  ${value}  `;
  return new Set(Array.from({ length: Math.max(0, text.length - 2) }, (_, i) => text.slice(i, i + 3)));
}

function similarity(left, right) {
  const a = trigrams(left);
  const b = trigrams(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return (2 * intersection) / (a.size + b.size);
}

function scoreDefinition(left, right) {
  const weights = { object_name: 0.1, object_category: 0.1, check_layer: 0.1, check_method: 0.2, description: 0.3, steps: 0.2, frequency: 0 };
  return Object.entries(weights).reduce((sum, [ field, weight ]) => sum + similarity(left[field], right[field]) * weight, 0);
}

module.exports = { normalizeText, normalizeDefinition, similarity, scoreDefinition };
