from pathlib import Path
import collections
import json
import re
import subprocess
import sys

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / 'reference-docs' / '最终留用资料'
SOURCE = REFERENCE / '规范满足情况-赋值提取复核-终版.xlsx'
PROJECT_SOURCE = REFERENCE / '曙光云多云同构项目表-261115.xlsx'
MAPPING_SOURCE = REFERENCE / '31168-2023标准编号与多云同构项目编号对应关系-章节顺序同步.xlsx'
OUTPUT = REFERENCE / '项目应答导入数据-261115.xlsx'
NODE = Path(r'C:\Users\dq\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')

SUMMARY_HEADERS = [
    '标准化编号', '条款号', '是否重点项', '应答赋值',
    '制度符合性描述', '实际证据', '适用性标记', '符合性标记', '备注',
]
DETAIL_HEADERS = [
    '标准化编号', '条款号', '提取类型', '需赋值项或选择项', '原文占位符',
    '占位符ID', '所属选择项ID', '是否选中/生效', '对应占位符的当前值',
    '原始当前赋值（导入）', '需要复核', '复核原因',
]


def text(value):
    return '' if value is None else str(value).strip()


def summary_text(value):
    value = text(value)
    return '' if value == '658' else value


def style_header(row):
    fill = PatternFill('solid', fgColor='28744A')
    for cell in row:
        cell.fill = fill
        cell.font = Font(bold=True, color='FFFFFF')
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)


def set_widths(ws, widths):
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width


def extract_status_markers():
    project = load_workbook(PROJECT_SOURCE, data_only=True)
    mapping = load_workbook(MAPPING_SOURCE, data_only=True)
    sheets = { str(worksheet.title): worksheet for worksheet in project.worksheets }
    markers = {}
    for row in mapping['编号对应关系'].iter_rows(min_row=2, values_only=True):
        standard_number, project_number, source_sheet, source_row = row[0], row[8], row[17], row[18]
        if not standard_number or not project_number or not source_sheet or not source_row:
            continue
        sheet = sheets[str(source_sheet).split('-', 1)[0]]
        header = next(sheet.iter_rows(min_row=2, max_row=2, values_only=True), ())
        status_columns = [
            index for index, value in enumerate(header)
            if value and '满足情况' in str(value)
        ]
        values = [ sheet.cell(int(source_row), column + 1).value for column in status_columns ]
        normalized = [
            str(value).strip() for value in values
            if value is not None and str(value).strip() and str(value).strip() != '/'
        ]
        if normalized and all(value == '不适用' for value in normalized):
            markers[str(standard_number)] = ('不适用', '未标记')
        elif any(value in ('不满足', '缺渗透报告') for value in normalized):
            markers[str(standard_number)] = ('适用', '不符合')
        elif '部分满足' in normalized:
            markers[str(standard_number)] = ('适用', '部分符合')
        elif any(value in ('满足', '符合') for value in normalized):
            markers[str(standard_number)] = ('适用', '符合')
        else:
            # 第6章没有单独的满足情况，但全部实际条款都有安全措施描述和证据；
            # 按业务口径视为符合，不把已编写的应答错误留成未标记。
            description_columns = [
                index for index, value in enumerate(header)
                if value and ('安全措施运行情况描述' in str(value) or '统一规范要求' in str(value))
            ]
            evidence_columns = [
                index for index, value in enumerate(header)
                if value and ('举证' in str(value) or '证据' in str(value))
            ]
            descriptions = [
                sheet.cell(int(source_row), column + 1).value
                for column in description_columns
            ]
            evidence = [
                sheet.cell(int(source_row), column + 1).value
                for column in evidence_columns
            ]
            has_answer = any(value is not None and str(value).strip() for value in descriptions)
            has_evidence = any(value is not None and str(value).strip() for value in evidence)
            markers[str(standard_number)] = (
                ('适用', '符合') if has_answer and has_evidence else ('适用', '未标记')
            )
    return markers


status_markers = extract_status_markers()
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
        'assignmentText': summary_text(row[2]),
        'complianceDescription': summary_text(row[3]),
        'actualEvidence': summary_text(row[4]),
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
    clause_numbers = sorted({row['clauseNumber'] for row in detail_by_number.get(record['standardNumber'], []) if row['clauseNumber']})
    applicability, compliance = status_markers.get(record['standardNumber'], ('', ''))
    summary.append([
        record['standardNumber'],
        '；'.join(clause_numbers),
        '',
        record['assignmentText'],
        record['complianceDescription'],
        record['actualEvidence'],
        applicability,
        compliance,
        '',
    ])
for row in summary.iter_rows(min_row=2):
    for cell in row:
        cell.alignment = Alignment(vertical='top', wrap_text=True)
set_widths(summary, [23, 22, 12, 38, 52, 38, 13, 13, 32])
summary.freeze_panes = 'A2'
summary.auto_filter.ref = f'A1:I{summary.max_row}'
for col, values in [('C', '是,否'), ('G', '未标记,适用,不适用'), ('H', '未标记,符合,部分符合,不符合')]:
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
status_rows = check['应答汇总']
applicability_counts = collections.Counter(
    status_rows.cell(row, 7).value for row in range(2, status_rows.max_row + 1)
)
compliance_counts = collections.Counter(
    status_rows.cell(row, 8).value for row in range(2, status_rows.max_row + 1)
)
print(json.dumps({
    'output': str(OUTPUT.resolve()),
    'sheets': check.sheetnames,
    'summaryRows': check['应答汇总'].max_row - 1,
    'detailRows': check['赋值明细'].max_row - 1,
    'sourceSummaryRows': len(summary_rows),
    'sourceDetailRows': len(detail_rows),
    'statusMarkers': len(status_markers),
    'applicabilityCounts': dict(applicability_counts),
    'complianceCounts': dict(compliance_counts),
}, ensure_ascii=False, indent=2))
