'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_SHEETS = 100;
const MAX_ROWS_PER_SHEET = 20000;
const MAX_ITEMS = 20000;
const DEFAULT_CLOUD_CENTERS = [ '统一运维中心', '抚州', '新疆' ];

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return String(value.text || '');
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellText(value.result);
  }
  return String(value);
}

function normalizeHeader(value) {
  return cellText(value).normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000]/g, '').replace(/[：:]/g, '');
}

function normalizeKey(value) {
  return cellText(value).normalize('NFKC').toLowerCase()
    .replace(/[\s\u3000]/g, '').replace(/[（）()【】\[\]、，,。；;：:]/g, '')
    .trim();
}

function importError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function findColumn(rows, aliases, start = 0) {
  const width = Math.max(rows[0]?.length || 0, rows[1]?.length || 0);
  for (const alias of aliases) {
    const wanted = normalizeHeader(alias);
    for (let index = start; index < width; index += 1) {
      const first = normalizeHeader(rows[0]?.[index]);
      const second = normalizeHeader(rows[1]?.[index]);
      if (first === wanted || second === wanted || first.includes(wanted) || second.includes(wanted)) return index;
    }
  }
  return -1;
}

function findHeader(rows) {
  const first = rows[0] || [];
  const second = rows[1] || [];
  const map = {
    externalItemNo: findColumn(rows, [ '标准项编号' ]),
    chapterCode: findColumn(rows, [ '章节号', '章节编号' ]),
    chapterName: findColumn(rows, [ '章节名称' ]),
    standardCode: findColumn(rows, [ '标准号' ]),
    standardName: findColumn(rows, [ '标准名称' ]),
    levelNumber: findColumn(rows, [ '级别号' ]),
    level: findColumn(rows, [ '级别' ]),
    clauseNumber: findColumn(rows, [ '条款号', '对应标准号', '标准编号' ]),
    content: findColumn(rows, [ '标准内容', '标准项内容', '标准要求' ]),
    isKey: findColumn(rows, [ '是否为重点项' ]),
    providerAssignment: findColumn(rows, [ '云服务商赋值' ]),
    unifiedRequirement: findColumn(rows, [ '多云统管制度规范体系具体要求', '多云统管体系具体要求', '统一规范要求' ]),
    expectedEvidence: findColumn(rows, [ '统一规范实施证据列表' ]),
    pendingEvidence: findColumn(rows, [ '待提供证据' ]),
    problem: findColumn(rows, [ '问题列' ]),
    responsible: findColumn(rows, [ '负责人' ]),
  };
  if (map.clauseNumber < 0 || map.content < 0) return null;
  const dataStart = first.some(value => normalizeHeader(value) === '标准项编号') || second.some(value => normalizeHeader(value) === '标准项编号') ? 2 : 1;
  return { map, dataStart };
}

function parseStatus(value) {
  const text = cellText(value).trim();
  if (!text) return null;
  if (/不适用|不涉及|不适?.*用/.test(text)) return { status: 'unassessed', applicability: 'not_applicable' };
  if (/部分|基本满足|有条件满足/.test(text)) return { status: 'partially_satisfied', applicability: 'applicable' };
  if (/不满足|不符合|不合格/.test(text)) return { status: 'not_satisfied', applicability: 'applicable' };
  if (/满足|符合|合格/.test(text)) return { status: 'satisfied', applicability: 'applicable' };
  return { status: 'unassessed', applicability: 'unspecified' };
}

function isEmptyEvidence(value) {
  const text = cellText(value).trim();
  return !text || /^(默认\s*[:：]?\s*)?无$/i.test(text) || text.length <= 3 && /^无[。.]?$/.test(text);
}

function splitEvidence(value) {
  if (isEmptyEvidence(value)) return [];
  return cellText(value).split(/\r?\n|；|;/).map(item => item.trim()).filter(item => !isEmptyEvidence(item));
}

function extractLine(text, labels) {
  const source = cellText(text);
  for (const label of labels) {
    const match = source.match(new RegExp(`${label}\\s*[:：]\\s*([^\\n]+)`, 'i'));
    if (match) return match[1].trim();
  }
  return '';
}

function findHeaderRow(rows, requiredAliases = []) {
  const wanted = requiredAliases.map(normalizeHeader);
  const limit = Math.min(rows.length, 12);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const headers = row.map(normalizeHeader);
    if (wanted.every(alias => headers.some(header => header === alias || header.includes(alias)))) {
      return { rowIndex, headers };
    }
  }
  return null;
}

function findAnswerColumn(headers, aliases) {
  const wanted = aliases.map(normalizeHeader);
  return headers.findIndex(header => wanted.some(alias => header === alias || header.includes(alias)));
}

function answerField(value, { hasProjectSequence = false } = {}) {
  const text = cellText(value).trim();
  if (!text) return '';
  // 规范满足情况.xlsx 中的父级说明行使用 658 作为空值占位，不应写入项目应答。
  if (!hasProjectSequence && text === '658') return '';
  return text;
}

function answerPlaceholderLabel(value) {
  const text = cellText(value).trim();
  if (!text) return '';
  return text
    .replace(/^\s*[\[［【]?\s*(?:赋值|选择)\s*[:：;；]?\s*/i, '')
    .replace(/[\]］】]\s*$/, '')
    .trim();
}

function selectedChoiceValue(row, value) {
  const selected = cellText(value).trim();
  if (row.type !== '选择' || !selected) return selected;
  const normalizeLabel = label => cellText(label).normalize('NFKC')
    .replace(/^\s*\[?\s*赋值\s*[:：]?\s*/i, '')
    .replace(/\]\s*$/, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
  const selectedLabel = normalizeLabel(selected);
  const nestedAssignments = cellText(row.placeholder).match(/[\[［【]\s*赋值\s*[:：]\s*[^\]］】\r\n]+[\]］】]/gu) || [];
  return nestedAssignments.find(token => normalizeLabel(token) === selectedLabel) || selected;
}

function parseActiveFlag(value) {
  const text = cellText(value).trim().toLowerCase();
  if (!text) return null;
  if ([ '否', '未选中', '不生效', 'no', 'false', '0' ].includes(text)) return false;
  if ([ '是', '选中', '生效', 'yes', 'true', '1' ].includes(text)) return true;
  return null;
}

function stripAssignmentPrefix(value, expectedLabel = '') {
  let text = cellText(value).trim().replace(/^\s*(?:赋值|选择)\s*\d*\s*[:：]\s*/i, '').trim();
  const lead = text.match(/^([^：:\n]{1,100})\s*[：:]\s*/);
  if (lead && expectedLabel && normalizeAssignmentLabel(lead[1]) === normalizeAssignmentLabel(expectedLabel)) {
    text = text.slice(lead[0].length).trim();
  }
  return text;
}

function numberedAssignmentSegments(value) {
  const source = cellText(value);
  const result = [];
  const pattern = /(?:^|[\r\n])\s*(?:(?:赋值|选择)\s*)?(?:[:：]\s*)?(\d+)\s*[：:、.]\s*([\s\S]*?)(?=(?:[\r\n])\s*(?:(?:赋值|选择)\s*)?(?:[:：]\s*)?\d+\s*[：:、.]|$)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const text = match[2].trim();
    if (text) result.push({ number: Number(match[1]), value: text });
  }
  return result;
}

function labeledAssignmentSegments(value) {
  const result = [];
  let current = null;
  for (const line of cellText(value).split(/\r?\n/)) {
    const match = line.match(/^\s*([^：:\n]{1,80})\s*[：:]\s*(.*)$/);
    if (match) {
      current = { label: match[1].trim(), value: match[2].trim() };
      result.push(current);
    } else if (current && line.trim()) {
      current.value = [ current.value, line.trim() ].filter(Boolean).join('\n');
    }
  }
  return result;
}

function normalizeAssignmentLabel(value) {
  return normalizeKey(value)
    .replace(/云服务商定义的|云服务商规定的|定义的/g, '')
    .replace(/频率|时间段|项目审查里程碑/g, '时间');
}

function labelValueForDetail(detail, labeled) {
  const target = normalizeAssignmentLabel(detail.label);
  const direct = labeled.find(item => {
    const candidate = normalizeAssignmentLabel(item.label);
    return candidate && (candidate === target || candidate.includes(target));
  });
  if (direct) return direct.value;
  if (/深度|广度|覆盖面/.test(detail.label)) {
    const scope = labeled.filter(item => /深度|广度|覆盖面/.test(item.label));
    if (scope.length) return scope.map(item => `${item.label}：${item.value}`).join('\n');
  }
  if (detail.type === '选择') {
    const selection = labeled.find(item => /选择/.test(item.label));
    if (selection) return selection.value;
  }
  return '';
}

function buildAnswerAssignmentDetails(detailRows, fallbackText) {
  const details = detailRows.filter(row => row.type === '赋值' || row.type === '选择');
  if (!details.length) return [];
  const sourceText = details.map(row => row.rawCurrentAssignment || row.currentAssignment).find(Boolean) || fallbackText || '';
  const numbered = numberedAssignmentSegments(sourceText);
  const labeled = labeledAssignmentSegments(sourceText);
  const hasNestedChoice = details.some(row => row.type === '选择' && /\[\s*[赋賦]值\s*[:：;]/u.test(row.placeholder || ''));
  return details.map((row, index) => {
    let value = row.currentAssignment || (row.hasMappedValue ? '' : sourceText);
    const genericReviewReason = /当前赋值可能对应一个或多个占位符/.test(row.reviewReason || '');
    let reviewRequired = row.needsReview === true && !genericReviewReason;
    let reviewReason = genericReviewReason ? '' : row.reviewReason || '';
    let mappingResolved = false;
    if (row.isActive === false && row.hasMappedValue) {
      value = '';
      mappingResolved = true;
    } else if (row.hasMappedValue) {
      mappingResolved = Boolean(String(value || '').trim());
      if (!mappingResolved) {
        reviewRequired = true;
        reviewReason = reviewReason || '该占位符标记为生效，但没有填写对应的当前值。';
      }
    } else if (details.length === 1) {
      const listValues = cellText(value).split(/\r?\n/)
        .map(line => line.match(/^\s*\d+\s*[、.)]\s*(.+)$/)?.[1]?.trim())
        .filter(Boolean);
      value = listValues.length > 1 ? listValues.join('\n') : stripAssignmentPrefix(value, row.label);
      mappingResolved = Boolean(String(value || '').trim());
    } else if (numbered.length >= details.length && numbered[index]) {
      value = numbered[index].value.replace(/^\s*\d+\s*[、.]\s*/, '').trim();
      mappingResolved = Boolean(value);
    } else if (labeled.length) {
      const matchedValue = labelValueForDetail(row, labeled);
      if (matchedValue) {
        value = matchedValue;
        mappingResolved = true;
      } else {
        reviewRequired = true;
        reviewReason = reviewReason || '存在多个赋值/选择项，未能按提示名称从赋值内容中唯一定位。';
      }
    } else if (numbered.length === 0) {
      reviewRequired = true;
      reviewReason = reviewReason || '同一标准项存在多个赋值/选择项，工作簿未提供可确定的一一对应序号。';
    }
    if (hasNestedChoice && !row.hasMappedValue && row.parentSelectionId === null) {
      reviewRequired = true;
      reviewReason = reviewReason || '选择项包含嵌套占位符；需要明确所选分支、分支内赋值及未选分支。';
    }
    if (row.parentSelectionId !== null && row.isActive === null && !row.hasMappedValue) {
      reviewRequired = true;
      reviewReason = reviewReason || '该赋值属于嵌套选择分支，但尚未确认此分支是否选中。';
    }
    if (row.hasMappedValue && mappingResolved && (row.isActive === false || Boolean(String(value || '').trim()))) {
      reviewRequired = false;
      reviewReason = '';
    }
    if (genericReviewReason && mappingResolved
      && (!hasNestedChoice || row.hasMappedValue)
      && (row.parentSelectionId === null || row.isActive !== null || row.hasMappedValue)) {
      reviewRequired = false;
      reviewReason = '';
    }
    return {
      type: row.type === '选择' ? 'selection' : 'assignment',
      label: row.type === '选择' ? '选择' : answerPlaceholderLabel(row.placeholder),
      placeholder: row.placeholder || null,
      value: (row.type === '选择' ? selectedChoiceValue(row, value) : value) || null,
      sourceRow: row.sourceRow,
      placeholderId: row.placeholderId || null,
      parentSelectionId: row.parentSelectionId,
      selected: row.isActive,
      reviewRequired,
      reviewReason: reviewReason || null,
    };
  });
}

function formatAnswerAssignments(details, fallbackText = '') {
  const visibleDetails = details.filter(detail => detail.selected !== false);
  if (!visibleDetails.length) return details.length ? '' : fallbackText || '';
  return visibleDetails.map(detail => {
    const label = detail.label || (detail.type === 'selection' ? '选择项' : '需赋值项');
    return `${label}：${detail.selected === false ? '未选中' : detail.value || '待确认'}`;
  }).join('\n');
}

function parseAnswerWorkbookRows(sheets) {
  const detailSheet = sheets.find(sheet => findHeaderRow(sheet.rows || [], [ '标准化编号', '原文占位符' ]));
  const summarySheet = sheets.find(sheet => sheet !== detailSheet && findHeaderRow(sheet.rows || [], [ '标准化编号' ])
    && (findHeaderRow(sheet.rows || [], [ '标准化编号', '规范体系具体要求' ])
      || findHeaderRow(sheet.rows || [], [ '标准化编号', '证据列表' ])));
  const onlyDetailSheet = !summarySheet && detailSheet ? detailSheet : null;
  if (!summarySheet && !detailSheet) return null;

  const byNumber = new Map();
  const getRow = (standardNumber, sourceSheet, sourceRow) => {
    const key = normalizeKey(standardNumber);
    if (!key) return null;
    if (!byNumber.has(key)) {
      byNumber.set(key, {
        sourceSheet,
        sourceRow,
        sourceKind: 'answer',
        standardNumber: cellText(standardNumber).trim(),
        projectSequence: '',
        clauseNumber: '',
        chapterCode: '',
        chapterName: '',
        headingPath: '',
        title: '',
        explanation: '',
        content: '',
        assignmentText: '',
        assignmentDetails: [],
        unifiedRequirement: '',
        expectedEvidence: '',
        actualEvidence: '',
        pendingEvidence: '',
        problem: '',
        responsible: '',
        cloudCenters: {},
        supervision: [],
      });
    }
    return byNumber.get(key);
  };

  if (summarySheet) {
    const found = findHeaderRow(summarySheet.rows || [], [ '标准化编号' ]);
    const headers = found.headers;
    const map = {
      standardNumber: findAnswerColumn(headers, [ '标准化编号' ]),
      projectSequence: findAnswerColumn(headers, [ '项目表序号(A列)', '项目表序号' ]),
      assignment: findAnswerColumn(headers, [ '赋值', '云服务商赋值', '当前赋值' ]),
      unifiedRequirement: findAnswerColumn(headers, [ '规范体系具体要求', '多云统管制度规范体系具体要求' ]),
      expectedEvidence: findAnswerColumn(headers, [ '统一规范实施证据列表', '应提供证据' ]),
      actualEvidence: findAnswerColumn(headers, [ '证据列表', '制度文件' ]),
    };
    for (let rowIndex = found.rowIndex + 1; rowIndex < summarySheet.rows.length; rowIndex += 1) {
      const source = summarySheet.rows[rowIndex] || [];
      const rawNumber = cellText(source[map.standardNumber]).trim();
      if (!rawNumber) continue;
      const projectSequence = answerField(source[map.projectSequence], { hasProjectSequence: Boolean(cellText(source[map.projectSequence]).trim()) });
      const row = getRow(rawNumber, summarySheet.name, rowIndex + 1);
      row.projectSequence = row.projectSequence || projectSequence;
      row.assignmentText = row.assignmentText || answerField(source[map.assignment], { hasProjectSequence: Boolean(projectSequence) });
      row.unifiedRequirement = row.unifiedRequirement || answerField(source[map.unifiedRequirement], { hasProjectSequence: Boolean(projectSequence) });
      row.expectedEvidence = row.expectedEvidence || answerField(source[map.expectedEvidence], { hasProjectSequence: Boolean(projectSequence) });
      row.actualEvidence = row.actualEvidence || answerField(source[map.actualEvidence], { hasProjectSequence: Boolean(projectSequence) });
    }
  }

  if (detailSheet) {
    const found = findHeaderRow(detailSheet.rows || [], [ '标准化编号', '原文占位符' ]);
    const headers = found.headers;
    const map = {
      standardNumber: findAnswerColumn(headers, [ '标准化编号' ]),
      projectSequence: findAnswerColumn(headers, [ '项目表序号(A列)', '项目表序号' ]),
      clauseNumber: findAnswerColumn(headers, [ '原标准项编号', '条款号', '标准项编号' ]),
      chapterCode: findAnswerColumn(headers, [ '章节编号', '章节号' ]),
      chapterName: findAnswerColumn(headers, [ '章节名称' ]),
      headingPath: findAnswerColumn(headers, [ '标题路径' ]),
      title: findAnswerColumn(headers, [ '标题', '标准项标题' ]),
      explanation: findAnswerColumn(headers, [ '条款说明' ]),
      content: findAnswerColumn(headers, [ '标准内容', '标准项内容' ]),
      extractionType: findAnswerColumn(headers, [ '提取类型' ]),
      placeholder: findAnswerColumn(headers, [ '原文占位符' ]),
      placeholderId: findAnswerColumn(headers, [ '占位符ID' ]) >= 0
        ? findAnswerColumn(headers, [ '占位符ID' ])
        : findAnswerColumn(headers, [ '占位符序号', '提取序号' ]),
      parentSelectionId: findAnswerColumn(headers, [ '所属选择项ID', '所属选择项序号', '所属选择项编号' ]),
      active: findAnswerColumn(headers, [ '是否选中/生效', '是否生效', '是否选中' ]),
      mappedValue: findAnswerColumn(headers, [ '对应占位符的当前值', '对应占位符当前值', '映射后当前赋值' ]),
      rawCurrentAssignment: findAnswerColumn(headers, [ '原始当前赋值（导入）', '原始当前赋值' ]),
      currentAssignment: findAnswerColumn(headers, [ '当前赋值' ]),
      label: findAnswerColumn(headers, [ '需赋值项或选择项', '占位符提示' ]),
      unifiedRequirement: findAnswerColumn(headers, [ '规范体系具体要求' ]),
      expectedEvidence: findAnswerColumn(headers, [ '统一规范实施证据列表', '应提供证据' ]),
      actualEvidence: findAnswerColumn(headers, [ '证据列表', '制度文件' ]),
      review: findAnswerColumn(headers, [ '需要复核' ]),
      reviewReason: findAnswerColumn(headers, [ '复核原因' ]),
      extractionStatus: findAnswerColumn(headers, [ '提取状态' ]),
    };
    const detailByNumber = new Map();
    for (let rowIndex = found.rowIndex + 1; rowIndex < detailSheet.rows.length; rowIndex += 1) {
      const source = detailSheet.rows[rowIndex] || [];
      const rawNumber = cellText(source[map.standardNumber]).trim();
      if (!rawNumber) continue;
      const hasProjectSequence = Boolean(cellText(source[map.projectSequence]).trim());
      const row = getRow(rawNumber, detailSheet.name, rowIndex + 1);
      row.projectSequence = row.projectSequence || answerField(source[map.projectSequence], { hasProjectSequence });
      row.clauseNumber = row.clauseNumber || answerField(source[map.clauseNumber], { hasProjectSequence });
      row.chapterCode = row.chapterCode || answerField(source[map.chapterCode], { hasProjectSequence });
      row.chapterName = row.chapterName || answerField(source[map.chapterName], { hasProjectSequence });
      row.headingPath = row.headingPath || answerField(source[map.headingPath], { hasProjectSequence });
      row.title = row.title || answerField(source[map.title], { hasProjectSequence });
      row.explanation = row.explanation || answerField(source[map.explanation], { hasProjectSequence });
      row.content = row.content || answerField(source[map.content], { hasProjectSequence });
      row.unifiedRequirement = row.unifiedRequirement || answerField(source[map.unifiedRequirement], { hasProjectSequence });
      row.expectedEvidence = row.expectedEvidence || answerField(source[map.expectedEvidence], { hasProjectSequence });
      row.actualEvidence = row.actualEvidence || answerField(source[map.actualEvidence], { hasProjectSequence });
      const detail = {
        type: answerField(source[map.extractionType], { hasProjectSequence }),
        placeholder: answerField(source[map.placeholder], { hasProjectSequence }),
        label: answerField(source[map.label], { hasProjectSequence }),
        rawCurrentAssignment: answerField(source[map.rawCurrentAssignment], { hasProjectSequence })
          || answerField(source[map.currentAssignment], { hasProjectSequence }),
        currentAssignment: map.mappedValue >= 0
          ? answerField(source[map.mappedValue], { hasProjectSequence })
          : answerField(source[map.rawCurrentAssignment >= 0 ? map.rawCurrentAssignment : map.currentAssignment], { hasProjectSequence }),
        hasMappedValue: map.mappedValue >= 0 && (
          Boolean(answerField(source[map.mappedValue], { hasProjectSequence }))
          || parseActiveFlag(source[map.active]) === false
          || Boolean(answerField(source[map.active], { hasProjectSequence })
            && answerField(source[map.review], { hasProjectSequence }) === '否'
            && answerField(source[map.extractionStatus], { hasProjectSequence }) === '已完成映射')
        ),
        placeholderId: answerField(source[map.placeholderId], { hasProjectSequence }),
        parentSelectionId: answerField(source[map.parentSelectionId], { hasProjectSequence }) || null,
        isActive: map.active >= 0 ? parseActiveFlag(source[map.active]) : null,
        sourceRow: rowIndex + 1,
        needsReview: /是|待核对|复核/.test(cellText(source[map.review])),
        reviewReason: answerField(source[map.reviewReason], { hasProjectSequence }),
      };
      if (detail.type === '赋值' || detail.type === '选择') {
        if (!detailByNumber.has(normalizeKey(rawNumber))) detailByNumber.set(normalizeKey(rawNumber), []);
        detailByNumber.get(normalizeKey(rawNumber)).push(detail);
      }
    }
    for (const [key, row] of byNumber) {
      const details = buildAnswerAssignmentDetails(detailByNumber.get(key) || [], row.assignmentText);
      if (details.length) {
        row.assignmentDetails = details;
        row.assignmentText = formatAnswerAssignments(details, row.assignmentText);
      }
    }
  }

  const rows = [ ...byNumber.values() ].filter(row => row.assignmentText || row.unifiedRequirement || row.expectedEvidence
    || row.actualEvidence || row.assignmentDetails.length || row.projectSequence || row.content || row.explanation);
  if (!rows.length) throw importError('未找到可导入的规范满足数据；请确认文件包含“标准化编号”列');
  const assignmentDetailCount = rows.reduce((sum, row) => sum + row.assignmentDetails.length, 0);
  const assignmentReviewCount = rows.reduce((sum, row) => sum + row.assignmentDetails.filter(item => item.reviewRequired).length, 0);
  return {
    rows,
    importedSheetCount: [ summarySheet, onlyDetailSheet || (detailSheet && summarySheet !== detailSheet ? detailSheet : null) ].filter(Boolean).length,
    skippedSheetCount: sheets.length - [ summarySheet, onlyDetailSheet || (detailSheet && summarySheet !== detailSheet ? detailSheet : null) ].filter(Boolean).length,
    cloudCenterNames: [],
    importMode: 'answer',
    assignmentDetailCount,
    assignmentReviewCount,
  };
}

function detectCloudGroups(rows, map) {
  const second = rows[1] || [];
  const starts = [];
  for (let index = Math.max(0, map.content + 1); index < second.length; index += 1) {
    if (normalizeHeader(second[index]).includes('满足情况')) starts.push(index);
  }
  return starts.map((start, index) => ({
    name: DEFAULT_CLOUD_CENTERS[index] || `云中心列组${index + 1}`,
    slot: index,
    status: start,
    measure: start + 1,
    evidence: start + 2,
  }));
}

function detectSupervisionGroups(rows, map) {
  const second = rows[1] || [];
  const starts = [];
  for (let index = Math.max(0, map.content + 1); index < second.length; index += 1) {
    const header = normalizeHeader(second[index]);
    if (header.includes('监督检查措施') || header.includes('监督检查机制')) starts.push(index);
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] || second.length;
    const contentColumns = [];
    const resultColumns = [];
    for (let column = start + 1; column < end; column += 1) {
      const header = cellText(second[column]);
      if (/检查内容/.test(header)) contentColumns.push({ column, label: header });
      if (/检查结果/.test(header)) resultColumns.push({ column, label: header });
    }
    return { measure: start, slot: index, contentColumns, resultColumns };
  });
}

function parseProjectRows(sheets) {
  const rows = [];
  let importedSheetCount = 0;
  let skippedSheetCount = 0;
  const cloudCenterNames = new Set();
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows || []);
    if (!header) {
      skippedSheetCount += 1;
      continue;
    }
    importedSheetCount += 1;
    const map = header.map;
    const cloudGroups = detectCloudGroups(sheet.rows, map);
    for (const group of cloudGroups) cloudCenterNames.add(group.name);
    const supervisionGroups = detectSupervisionGroups(sheet.rows, map);
    const carry = {};
    for (let rowIndex = header.dataStart; rowIndex < sheet.rows.length; rowIndex += 1) {
      const source = sheet.rows[rowIndex] || [];
      const value = column => column >= 0 ? cellText(source[column]).trim() : '';
      const clauseNumber = value(map.clauseNumber);
      const content = value(map.content);
      if (!clauseNumber && !content) continue;
      if (!clauseNumber) throw importError(`工作表“${sheet.name}”第${rowIndex + 1}行缺少条款号`);
      if (!content) throw importError(`工作表“${sheet.name}”第${rowIndex + 1}行缺少标准内容`);
      for (const field of [ 'chapterCode', 'chapterName', 'standardCode', 'standardName', 'levelNumber', 'level' ]) {
        const current = value(map[field]);
        if (current) carry[field] = current;
      }
      const cloudCenters = {};
      for (const group of cloudGroups) {
        const status = value(group.status);
        const measure = value(group.measure);
        const evidence = value(group.evidence);
        if (status || measure || evidence) {
          cloudCenters[group.name] = { status: parseStatus(status), measure, evidence, evidenceItems: splitEvidence(evidence) };
          cloudCenterNames.add(group.name);
        }
      }
      const supervision = [];
      for (const group of supervisionGroups) {
        const measure = value(group.measure);
        if (!measure) continue;
        const observations = [];
        for (const [ contentIndex, column ] of group.contentColumns.entries()) {
          const checkedContent = value(column.column);
          if (!checkedContent) continue;
          const centerName = column.label.split(/[-：:]/).slice(1).join('-').trim();
          const resultColumn = group.resultColumns.find(item => item.column > column.column);
          const slot = group.contentColumns.length > 1 ? contentIndex : group.slot;
          observations.push({ centerName, slot, content: checkedContent, result: resultColumn ? value(resultColumn.column) : '' });
        }
        supervision.push({ measure, slot: group.slot, frequency: extractLine(measure, [ '检查频率', '频率' ]), method: extractLine(measure, [ '检查方法', '检查方式' ]), observations });
      }
      const isKeyText = value(map.isKey);
      rows.push({
        sourceSheet: sheet.name,
        sourceRow: rowIndex + 1,
        externalItemNo: value(map.externalItemNo),
        chapterCode: carry.chapterCode || '',
        chapterName: carry.chapterName || sheet.name,
        standardCode: carry.standardCode || '',
        standardName: carry.standardName || '',
        levelNumber: carry.levelNumber || '',
        level: carry.level || '',
        clauseNumber,
        content,
        isKey: isKeyText ? /是|重点|重要|yes|true/i.test(isKeyText) : null,
        providerAssignment: value(map.providerAssignment),
        unifiedRequirement: value(map.unifiedRequirement),
        expectedEvidence: value(map.expectedEvidence),
        pendingEvidence: value(map.pendingEvidence),
        problem: value(map.problem),
        responsible: value(map.responsible),
        cloudCenters,
        supervision,
      });
      if (rows.length > MAX_ITEMS) throw importError(`一次最多导入${MAX_ITEMS}个标准项`);
    }
  }
  if (!rows.length) throw importError('未找到可导入的项目标准项；请确认文件包含“条款号”和“标准内容”列');
  const rowByCode = new Map();
  for (const row of rows) {
    const key = normalizeKey(row.clauseNumber);
    if (rowByCode.has(key)) {
      const previous = rowByCode.get(key);
      throw importError(`条款号“${row.clauseNumber}”重复（工作表“${previous.sourceSheet}”第${previous.sourceRow}行、工作表“${row.sourceSheet}”第${row.sourceRow}行）`);
    }
    rowByCode.set(key, row);
  }
  return { rows, importedSheetCount, skippedSheetCount, cloudCenterNames: [ ...cloudCenterNames ] };
}

async function parseProjectWorkbookFile(filePath, fileName) {
  const extension = path.extname(fileName || filePath).toLowerCase();
  if (extension !== '.xlsx') throw importError('项目数据导入仅支持 .xlsx 文件');
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) throw importError('项目数据文件不能超过50MB');
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath, { ignoreNodes: [ 'dataValidations' ] });
  } catch (error) {
    const wrapped = importError('Excel文件无法读取，请确认文件为有效的.xlsx工作簿');
    wrapped.cause = error;
    throw wrapped;
  }
  if (workbook.worksheets.length > MAX_SHEETS) throw importError(`工作簿最多支持${MAX_SHEETS}个工作表`);
  const sheets = workbook.worksheets.map(worksheet => {
    if (worksheet.rowCount > MAX_ROWS_PER_SHEET || worksheet.columnCount > 512) throw importError(`工作表“${worksheet.name}”行数或列数超出导入限制`);
    const rows = [];
    worksheet.eachRow({ includeEmpty: true }, row => { rows[row.number - 1] = (row.values || []).slice(1).map(cellText); });
    return { name: worksheet.name, rows };
  });
  const answerPayload = parseAnswerWorkbookRows(sheets);
  if (answerPayload) return answerPayload;
  return parseProjectRows(sheets);
}

module.exports = {
  DEFAULT_CLOUD_CENTERS,
  parseProjectRows,
  parseAnswerWorkbookRows,
  parseProjectWorkbookFile,
  parseStatus,
  normalizeKey,
  splitEvidence,
};
