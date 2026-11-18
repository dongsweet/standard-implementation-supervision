'use strict';

const OPEN_TO_CLOSE = new Map([
  [ '[', ']' ],
  [ '［', '］' ],
  [ '【', '】' ],
]);
const CLOSERS = new Set(OPEN_TO_CLOSE.values());

function text(value) {
  return String(value || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

function compact(value) {
  return text(value).replace(/\s+/g, ' ');
}

function matchKey(value) {
  return compact(value)
    .normalize('NFKC')
    .replace(/^[\[［【]\s*/, '')
    .replace(/[\]］】]\s*$/, '')
    .replace(/^(?:赋值|选择)\s*[:：;；]?\s*/i, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function assignmentLabel(placeholder) {
  return text(placeholder)
    .replace(/^[\[［【]\s*/, '')
    .replace(/[\]］】]\s*$/, '')
    .replace(/^(?:赋值|选择)\s*[:：;；]?\s*/i, '')
    .trim();
}

function findClosing(source, start) {
  const stack = [ OPEN_TO_CLOSE.get(source[start]) ];
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (OPEN_TO_CLOSE.has(char)) {
      stack.push(OPEN_TO_CLOSE.get(char));
    } else if (CLOSERS.has(char)) {
      if (char !== stack[stack.length - 1]) return -1;
      stack.pop();
      if (!stack.length) return index;
    }
  }
  return -1;
}

function placeholderTokens(source) {
  const value = text(source);
  const tokens = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!OPEN_TO_CLOSE.has(value[index])) continue;
    const end = findClosing(value, index);
    if (end < 0) break;
    const raw = value.slice(index, end + 1);
    const inner = compact(raw.slice(1, -1));
    const match = inner.match(/^(选择|赋值)\s*[:：;；]\s*([\s\S]*)$/);
    if (match) {
      tokens.push({
        type: match[1] === '选择' ? 'selection' : 'assignment',
        raw,
        body: match[2].trim(),
        index: tokens.length,
      });
    }
    index = end;
  }
  return tokens;
}

function splitOptions(value) {
  const source = text(value);
  const result = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (OPEN_TO_CLOSE.has(char)) depth += 1;
    else if (CLOSERS.has(char)) depth = Math.max(0, depth - 1);
    else if ((char === ';' || char === '；') && depth === 0) {
      const option = source.slice(start, index).trim();
      if (option) result.push(option);
      start = index + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) result.push(last);
  return result;
}

function optionControl(value, selectionKey, optionIndex) {
  const raw = text(value);
  const nested = placeholderTokens(raw);
  const assignment = nested.find(token => token.type === 'assignment' && token.raw === raw);
  return {
    value: raw,
    label: assignment ? assignmentLabel(assignment.raw) : raw,
    assignmentLabel: assignment ? assignmentLabel(assignment.raw) : '',
    assignmentPlaceholder: assignment ? assignment.raw : '',
    childKey: assignment ? `${selectionKey}:assignment:${optionIndex + 1}` : '',
  };
}

function valueMatchesOption(value, option) {
  const key = matchKey(value);
  return Boolean(key) && [ option.value, option.label, option.assignmentLabel ]
    .some(candidate => matchKey(candidate) === key);
}

function findExisting(details, type, placeholder, parentSelectionId = null) {
  const key = matchKey(placeholder);
  return details.find(detail => {
    if (detail.type !== type) return false;
    if ((detail.parentSelectionId || null) !== parentSelectionId) return false;
    return matchKey(detail.placeholder) === key;
  });
}

function buildAssignmentForm(source, existingDetails = []) {
  const value = text(source);
  const details = Array.isArray(existingDetails) ? existingDetails : [];
  const tokens = placeholderTokens(value);
  const controls = [];
  let selectionIndex = 0;
  let assignmentIndex = 0;

  for (const token of tokens) {
    if (token.type === 'selection') {
      selectionIndex += 1;
      const existing = findExisting(details, 'selection', token.raw);
      const key = existing?.placeholderId || `selection:${selectionIndex}`;
      const options = splitOptions(token.body).map((option, index) => optionControl(option, key, index));
      const selectedValues = [];
      const existingValues = Array.isArray(existing?.selectedValues)
        ? existing.selectedValues
        : existing?.value ? [ existing.value ] : [];
      for (const option of options) {
        const child = option.assignmentPlaceholder
          ? findExisting(details, 'assignment', option.assignmentPlaceholder, existing?.placeholderId || key)
          : null;
        if (existingValues.some(candidate => valueMatchesOption(candidate, option))
          || child?.selected === true) {
          selectedValues.push(option.value);
        }
      }
      const optionStates = options.map((option, optionIndex) => {
        const child = option.assignmentPlaceholder
          ? findExisting(details, 'assignment', option.assignmentPlaceholder, existing?.placeholderId || key)
          : null;
        return {
          ...option,
          selected: selectedValues.includes(option.value),
          assignmentValue: child?.value || '',
          assignmentPlaceholderId: `${key}:assignment:${optionIndex + 1}`,
        };
      });
      controls.push({
        kind: 'selection',
        key,
        label: '选择',
        placeholder: token.raw,
        options: optionStates,
        selectedValues,
      });
    } else {
      assignmentIndex += 1;
      const existing = findExisting(details, 'assignment', token.raw, null);
      controls.push({
        kind: 'assignment',
        key: existing?.placeholderId || `assignment:${assignmentIndex}`,
        label: assignmentLabel(token.raw),
        placeholder: token.raw,
        value: existing?.value || '',
        selected: true,
      });
    }
  }

  return {
    controls,
    hasStructuredControls: controls.length > 0,
    legacyText: details.length ? formatSubmittedDetails(details).clauseAssignment : '',
  };
}

function normalizeDetails(rawDetails, sourceText, options = {}) {
  const source = text(sourceText);
  const form = buildAssignmentForm(source);
  if (!form.hasStructuredControls) {
    const details = (Array.isArray(rawDetails) ? rawDetails : [])
      .filter(detail => detail && detail.type === 'assignment' && text(detail.value))
      .map((detail, index) => ({
        type: 'assignment',
        label: compact(detail.label) || '需赋值项',
        placeholder: text(detail.placeholder) || null,
        value: text(detail.value),
        selected: true,
        selectedValues: [],
        placeholderId: text(detail.placeholderId) || `assignment:${index + 1}`,
        parentSelectionId: null,
        reviewRequired: false,
      }));
    return { details, ...formatSubmittedDetails(details) };
  }

  const input = Array.isArray(rawDetails) ? rawDetails : [];
  const selections = input.filter(detail => detail?.type === 'selection');
  const assignmentByKey = new Map();
  for (const detail of input.filter(item => item?.type === 'assignment')) {
    const key = [
      matchKey(detail.placeholder),
      text(detail.parentSelectionId),
    ].join('|');
    const existing = assignmentByKey.get(key);
    if (!existing || (!text(existing.value) && text(detail.value)) || existing.selected === false) {
      assignmentByKey.set(key, detail);
    }
  }
  const assignments = [ ...assignmentByKey.values() ];
  const normalized = [];
  const consumedAssignments = new Set();

  for (const control of form.controls) {
    if (control.kind === 'assignment') {
      const candidate = assignments.find(detail =>
        matchKey(detail.placeholder) === matchKey(control.placeholder)
        && !detail.parentSelectionId
      );
      if (candidate) consumedAssignments.add(candidate);
      const assignmentValue = text(candidate?.value);
      if (assignmentValue) {
        normalized.push({
          type: 'assignment',
          label: control.label,
          placeholder: control.placeholder,
          value: assignmentValue,
          selected: true,
          selectedValues: [],
          placeholderId: text(candidate?.placeholderId) || control.key,
          parentSelectionId: null,
          reviewRequired: Boolean(candidate?.reviewRequired),
          reviewReason: candidate?.reviewReason || null,
        });
      }
      continue;
    }

    const submittedSelection = selections.find(detail =>
      text(detail.placeholderId) === control.key
      || matchKey(detail.placeholder) === matchKey(control.placeholder)
    );
    const submittedValues = Array.isArray(submittedSelection?.selectedValues)
      ? submittedSelection.selectedValues
      : submittedSelection?.value ? [ submittedSelection.value ] : [];
    const selectedOptions = control.options.filter(option =>
      submittedValues.some(candidate => valueMatchesOption(candidate, option))
    );
    if (!selectedOptions.length) continue;
    const selectionKey = text(submittedSelection?.placeholderId) || control.key;

    normalized.push({
      type: 'selection',
      label: '选择',
      placeholder: control.placeholder,
      value: selectedOptions[0].value,
      selectedValues: selectedOptions.map(option => option.value),
      selected: true,
      placeholderId: selectionKey,
      parentSelectionId: null,
      reviewRequired: Boolean(submittedSelection?.reviewRequired),
      reviewReason: submittedSelection?.reviewReason || null,
    });

    for (const option of selectedOptions) {
      if (!option.assignmentPlaceholder) continue;
      const candidate = assignments.find(detail =>
        (detail.parentSelectionId === selectionKey || detail.parentSelectionId === control.key)
        && matchKey(detail.placeholder) === matchKey(option.assignmentPlaceholder)
      ) || assignments.find(detail =>
        matchKey(detail.placeholder) === matchKey(option.assignmentPlaceholder)
      );
      if (candidate) consumedAssignments.add(candidate);
      const assignmentValue = text(candidate?.value);
      const optionIndex = control.options.findIndex(candidateOption => candidateOption.value === option.value);
      normalized.push({
        type: 'assignment',
        label: option.assignmentLabel,
        placeholder: option.assignmentPlaceholder,
        value: assignmentValue || null,
        selected: true,
        selectedValues: [],
        placeholderId: text(candidate?.placeholderId) || `${selectionKey}:assignment:${optionIndex + 1}`,
        parentSelectionId: selectionKey,
        reviewRequired: !assignmentValue || Boolean(candidate?.reviewRequired),
        reviewReason: !assignmentValue
          ? `已选择“${option.label}”，请填写对应赋值。`
          : candidate?.reviewReason || null,
      });
    }
  }

  if (options.preserveUnmatched) {
    for (const candidate of assignments) {
      if (consumedAssignments.has(candidate) || candidate.selected === false || candidate.parentSelectionId) continue;
      const value = text(candidate.value);
      if (!value) continue;
      if (normalized.some(detail => detail.type === 'assignment'
        && matchKey(detail.placeholder) === matchKey(candidate.placeholder))) continue;
      normalized.push({
        type: 'assignment',
        label: compact(candidate.label) || '需赋值项',
        placeholder: text(candidate.placeholder) || null,
        value,
        selected: true,
        selectedValues: [],
        placeholderId: text(candidate.placeholderId) || `assignment:${normalized.length + 1}`,
        parentSelectionId: null,
        reviewRequired: Boolean(candidate.reviewRequired),
        reviewReason: candidate.reviewReason || null,
      });
    }
  }

  return { details: normalized, ...formatSubmittedDetails(normalized) };
}

function formatSubmittedDetails(details) {
  const labels = new Map();
  const lines = [];
  for (const detail of details) {
    if (detail.type === 'selection') {
      const values = Array.isArray(detail.selectedValues)
        ? detail.selectedValues
        : detail.value ? [ detail.value ] : [];
      if (!values.length) continue;
      const displayValues = values.map(value => assignmentLabel(value) || value);
      labels.set(detail.placeholderId, values);
      lines.push(`选择：${displayValues.join('；')}`);
      continue;
    }
    if (detail.type !== 'assignment' || detail.selected === false) continue;
    const label = compact(detail.label) || '需赋值项';
    lines.push(`${label}：${text(detail.value) || '待填写'}`);
  }
  return { clauseAssignment: lines.join('\n') };
}

module.exports = {
  assignmentLabel,
  buildAssignmentForm,
  formatSubmittedDetails,
  normalizeDetails,
  placeholderTokens,
  splitOptions,
};
