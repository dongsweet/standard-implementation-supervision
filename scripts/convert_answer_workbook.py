from pathlib import Path
import collections
import json
import re
import subprocess

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

STANDARD_CODE = 'GB/T 31168'
STANDARD_NAME = '信息安全技术 云计算服务安全能力要求'
STANDARD_VERSION = '2023'
SUMMARY_HEADERS = [
    '标准化编号', '条款号', '是否重点项', '应答赋值',
    '制度符合性描述', '实际证据', '适用性标记', '符合性标记', '备注',
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
    number = record['standardNumber']
    detail_input.setdefault(number, []).append(record)
    if record['placeholder']:
        content_input.setdefault(number, []).append(record['placeholder'])

payload_path = OUTPUT.with_suffix('.mapping-input.json')
mapped_path = OUTPUT.with_suffix('.mapping-output.json')
script_path = ROOT / 'scripts' / 'map_answer_assignments.js'
payload_path.write_text(json.dumps({
    'details': detail_input,
    'summaries': summary_by_number,
    'contents': {key: '\n'.join(values) for key, values in content_input.items()},
}, ensure_ascii=False), encoding='utf-8')
subprocess.run([str(NODE), str(script_path), str(payload_path), str(mapped_path)], cwd=ROOT, check=True)
mapped = json.loads(mapped_path.read_text(encoding='utf-8'))
for record in summary_rows:
    normalized = mapped.get(record['standardNumber'], {})
    if normalized.get('assignmentText'):
        record['assignmentText'] = normalized['assignmentText']

output = Workbook()
instructions = output.active
instructions.title = '填写说明'
instructions.append(['项目应答导入模板填写说明'])
instructions.merge_cells('A1:B1')
instructions['A1'].font = Font(bold=True, size=15, color='1F4D36')
instruction_rows = [
    ('工作表', '每个标准单独一个工作表，名称使用可读的标准名称。'),
    ('条款号', '标准条款定位列，由系统预填。'),
    ('应答赋值', '填写人可阅读的最终应答，不需要填写占位符 ID 或内部映射。'),
    ('赋值示例', '选择：选项名称；赋值项按“提示名称：赋值内容”填写，多项时每行一项。'),
    ('适用性标记', '可填：未标记、适用、不适用。'),
    ('符合性标记', '可填：未标记、符合、部分符合、不符合。'),
    ('是否重点项', '可填：是、否。'),
    ('标准化编号', '按当前项目预填，用于精确匹配标准项，请勿修改。'),
]
for values in instruction_rows:
    instructions.append(values)
style_header(instructions[2])
set_widths(instructions, [24, 92])

summary = output.create_sheet(STANDARD_NAME)
summary.append([f'{STANDARD_NAME} · {STANDARD_CODE} · {STANDARD_VERSION}'])
summary.merge_cells('A1:I1')
summary['A1'].font = Font(bold=True, size=14, color='1F4D36')
summary['A1'].alignment = Alignment(vertical='center')
summary.row_dimensions[1].height = 28
summary.append(SUMMARY_HEADERS)
style_header(summary[2])
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
for row in summary.iter_rows(min_row=3):
    for cell in row:
        cell.alignment = Alignment(vertical='top', wrap_text=True)
set_widths(summary, [23, 16, 12, 42, 58, 38, 13, 13, 32])
summary.freeze_panes = 'A3'
summary.auto_filter.ref = f'A2:I{summary.max_row}'
for col, values in [('C', '是,否'), ('G', '未标记,适用,不适用'), ('H', '未标记,符合,部分符合,不符合')]:
    validation = DataValidation(type='list', formula1=f'"{values}"', allow_blank=True)
    summary.add_data_validation(validation)
    validation.add(f'{col}3:{col}{summary.max_row}')

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
output.save(OUTPUT)
payload_path.unlink(missing_ok=True)
mapped_path.unlink(missing_ok=True)

check = load_workbook(OUTPUT, data_only=False)
status_rows = check[STANDARD_NAME]
applicability_counts = collections.Counter(
    status_rows.cell(row, 7).value for row in range(3, status_rows.max_row + 1)
)
compliance_counts = collections.Counter(
    status_rows.cell(row, 8).value for row in range(3, status_rows.max_row + 1)
)
print(json.dumps({
    'output': str(OUTPUT.resolve()),
    'sheets': check.sheetnames,
    'summaryRows': status_rows.max_row - 2,
    'sourceSummaryRows': len(summary_rows),
    'sourceDetailRows': len(detail_rows),
    'statusMarkers': len(status_markers),
    'applicabilityCounts': dict(applicability_counts),
    'complianceCounts': dict(compliance_counts),
}, ensure_ascii=False, indent=2))
