from pathlib import Path
import json
import re
import subprocess
import sys

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'reference-docs' / '规范满足情况-赋值提取复核-终版.xlsx'
OUTPUT = ROOT / 'outputs' / '项目应答导入模板转换结果.xlsx'
NODE = Path(r'C:\Users\dq\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')

SUMMARY_HEADERS = [
    '标准化编号', '条款号', '项目表序号(A列)', '是否重点项', '应答赋值',
    '制度符合性描述', '所需证据', '实际证据', '适用性标记', '符合性标记', '备注',
]
DETAIL_HEADERS = [
    '标准化编号', '条款号', '提取类型', '需赋值项或选择项', '原文占位符',
    '占位符ID', '所属选择项ID', '是否选中/生效', '对应占位符的当前值',
    '原始当前赋值（导入）', '需要复核', '复核原因',
]


def text(value):
    return '' if value is None else str(value).strip()


def style_header(row):
    fill = PatternFill('solid', fgColor='28744A')
    for cell in row:
        cell.fill = fill
        cell.font = Font(bold=True, color='FFFFFF')
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)


def set_widths(ws, widths):
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width


source = load_workbook(SOURCE, data_only=False)
summary_source = source['Sheet1']
detail_source = source['赋值提取复核']

summary_rows = []
summary_by_number = {}
for row in summary_source.iter_rows(min_row=2, values_only=True):
    number = text(row[0])
    if not number:
        continue
    record = {
        'standardNumber': number,
        'projectSequence': text(row[1]),
        'assignmentText': text(row[2]),
        'complianceDescription': text(row[3]),
        'actualEvidence': text(row[4]),
    }
    summary_rows.append(record)
    summary_by_number[number] = record

detail_rows = []
detail_by_number = {}
for row in detail_source.iter_rows(min_row=2, values_only=True):
    number = text(row[1])
    if not number:
        continue
    record = {
        'standardNumber': number,
        'projectSequence': text(row[2]),
        'clauseNumber': text(row[3]),
        'extractionType': text(row[12]),
        'label': text(row[13]),
        'placeholder': text(row[15]),
        'currentAssignment': text(row[16]),
        'complianceDescription': text(row[17]),
        'actualEvidence': text(row[18]),
        'review': text(row[20]),
        'reviewReason': text(row[21]),
        'extractionStatus': text(row[19]),
        'placeholderId': text(row[22]),
        'parentSelectionId': text(row[23]),
        'active': text(row[24]),
        'mappedValue': text(row[25]),
        'rawCurrentAssignment': text(row[26]),
        'sourceRow': len(detail_rows) + 2,
    }
    detail_rows.append(record)
    detail_by_number.setdefault(number, []).append(record)
    if not summary_by_number.get(number):
        summary_by_number[number] = {
            'standardNumber': number,
            'projectSequence': record['projectSequence'],
            'assignmentText': '',
            'complianceDescription': record['complianceDescription'],
            'actualEvidence': record['actualEvidence'],
        }

detail_input = {}
content_input = {}
for record in detail_rows:
    key = record['standardNumber']
    detail_input.setdefault(key, []).append(record)
    if record['placeholder']:
        content_input.setdefault(key, []).append(record['placeholder'])

payload_path = OUTPUT.with_suffix('.mapping-input.json')
mapped_path = OUTPUT.with_suffix('.mapping-output.json')
script_path = ROOT / 'scripts' / 'map_answer_assignments.js'
for records in detail_input.values():
    for record in records:
        record['explicitPlaceholderId'] = True
payload_path.write_text(json.dumps({
    'details': detail_input,
    'summaries': summary_by_number,
    'contents': {key: '\n'.join(values) for key, values in content_input.items()},
}, ensure_ascii=False), encoding='utf-8')
subprocess.run([str(NODE), str(script_path), str(payload_path), str(mapped_path)], cwd=ROOT, check=True)
mapped = json.loads(mapped_path.read_text(encoding='utf-8'))

output = Workbook()
instructions = output.active
instructions.title = '填写说明'
instructions.append(['项目应答导入模板填写说明'])
instructions.merge_cells('A1:B1')
instructions['A1'].font = Font(bold=True, size=15, color='1F4D36')
instruction_rows = [
    ('工作表', '用途'),
    ('应答汇总', '每条标准项的最终应答。'),
    ('赋值明细', '仅标准原文包含[赋值：...]或[选择：...]时填写。'),
    ('适用性标记', '可填：未标记、适用、不适用。'),
    ('符合性标记', '可填：未标记、符合、部分符合、不符合。'),
    ('是否重点项', '可填：是、否。'),
    ('赋值规则', '只提交已选分支；未选分支“是否选中/生效”填“否”，不填当前值。'),
]
for values in instruction_rows:
    instructions.append(values)
style_header(instructions[2])
set_widths(instructions, [24, 92])

summary = output.create_sheet('应答汇总')
summary.append(SUMMARY_HEADERS)
style_header(summary[1])
for record in summary_rows:
    print_result = summary_by_number[record['standardNumber']]
    details = mapped.get(record['standardNumber'], [])
    clause_numbers = sorted({row['clauseNumber'] for row in detail_by_number.get(record['standardNumber'], []) if row['clauseNumber']})
    summary.append([
        record['standardNumber'],
        '；'.join(clause_numbers),
        record['projectSequence'],
        '',
        record['assignmentText'],
        record['complianceDescription'],
        '',
        record['actualEvidence'],
        '',
        '',
        '',
    ])
for row in summary.iter_rows(min_row=2):
    for cell in row:
        cell.alignment = Alignment(vertical='top', wrap_text=True)
set_widths(summary, [23, 22, 17, 12, 38, 52, 28, 38, 13, 13, 32])
summary.freeze_panes = 'A2'
summary.auto_filter.ref = f'A1:K{summary.max_row}'
for col, values in [('D', '是,否'), ('I', '未标记,适用,不适用'), ('J', '未标记,符合,部分符合,不符合')]:
    validation = DataValidation(type='list', formula1=f'"{values}"', allow_blank=True)
    summary.add_data_validation(validation)
    validation.add(f'{col}2:{col}{summary.max_row}')

details_sheet = output.create_sheet('赋值明细')
details_sheet.append(DETAIL_HEADERS)
style_header(details_sheet[1])
for number, details in mapped.items():
    clause_numbers = sorted({row['clauseNumber'] for row in detail_by_number.get(number, []) if row['clauseNumber']})
    for detail in details:
        details_sheet.append([
            number,
            '；'.join(clause_numbers),
            '选择' if detail.get('type') == 'selection' else '赋值',
            detail.get('label') or '',
            detail.get('placeholder') or '',
            detail.get('placeholderId') or '',
            detail.get('parentSelectionId') or '',
            '否' if detail.get('selected') is False else '是',
            '；'.join(detail.get('selectedValues') or []) if detail.get('type') == 'selection'
            else (detail.get('value') or ''),
            detail_by_number[number][0]['rawCurrentAssignment'] if detail_by_number.get(number) else '',
            '是' if detail.get('reviewRequired') else '否',
            detail.get('reviewReason') or '',
        ])
for row in details_sheet.iter_rows(min_row=2):
    for cell in row:
        cell.alignment = Alignment(vertical='top', wrap_text=True)
set_widths(details_sheet, [23, 22, 12, 34, 52, 34, 34, 15, 40, 42, 12, 42])
details_sheet.freeze_panes = 'A2'
details_sheet.auto_filter.ref = f'A1:L{details_sheet.max_row}'
for col, values in [('C', '赋值,选择'), ('H', '是,否'), ('K', '是,否')]:
    validation = DataValidation(type='list', formula1=f'"{values}"', allow_blank=True)
    details_sheet.add_data_validation(validation)
    validation.add(f'{col}2:{col}{details_sheet.max_row}')

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
output.save(OUTPUT)
for path in [payload_path, mapped_path, OUTPUT.with_suffix('.mapping.js')]:
    path.unlink(missing_ok=True)

check = load_workbook(OUTPUT, data_only=False)
print(json.dumps({
    'output': str(OUTPUT.resolve()),
    'sheets': check.sheetnames,
    'summaryRows': check['应答汇总'].max_row - 1,
    'detailRows': check['赋值明细'].max_row - 1,
    'sourceSummaryRows': len(summary_rows),
    'sourceDetailRows': len(detail_rows),
}, ensure_ascii=False, indent=2))
