import { BadRequestException } from "@nestjs/common";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_COLUMNS = 100;
const MAX_INFLATED_BYTES = 20 * 1024 * 1024;
const invalid = (message: string): never => {
  throw new BadRequestException(message);
};
function headersAndRows(matrix: string[][]) {
  const header = matrix[0];
  if (!header?.some((s) => s.trim()))
    return invalid("The file must have a header row");
  if (header.length > MAX_COLUMNS)
    return invalid("At most 100 columns can be imported");
  const headers = header.map((s, i) => s.trim() || `Column ${i + 1}`);
  if (headers.some((h) => h.length > 160))
    return invalid("Column names must be at most 160 characters");
  if (new Set(headers).size !== headers.length)
    return invalid("Column names must be unique; rename duplicate headers");
  const data = matrix.slice(1).filter((row) => row.some((cell) => cell.trim()));
  if (data.length > MAX_ROWS)
    return invalid("At most 2,000 data rows can be imported in one file");
  for (const row of data) {
    if (row.length > headers.length)
      return invalid("A data row has more cells than the header");
    if (row.some((cell) => cell.length > 4000))
      return invalid("Cells must contain at most 4,000 characters");
  }
  const rows = data.map((row) =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])),
  );
  return { headers, rows, totalRows: rows.length };
}
function parseCsv(buffer: Buffer) {
  if (buffer.includes(0)) return invalid("CSV must be UTF-8 text");
  // Count separators outside quoted fields in the first logical record.
  const source = buffer.toString("utf8").replace(/^\uFEFF/, "");
  let quoted = false;
  const counts = new Map([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"') {
      if (quoted && source[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  const delimiter = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  let records: string[][];
  try {
    records = parse(source, {
      bom: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 400100,
      on_record: (record: string[], context: { records: number }) => {
        if (context.records > MAX_ROWS + 1)
          return invalid("At most 2,000 data rows can be imported in one file");
        if (record.length > MAX_COLUMNS)
          return invalid("At most 100 columns can be imported");
        return record;
      },
    });
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    return invalid("CSV could not be parsed; check its quotes and delimiters");
  }
  return headersAndRows(records);
}
function columnNumber(letters: string) {
  let n = 0;
  for (const c of letters) n = n * 26 + c.charCodeAt(0) - 64;
  return n;
}
// Validate every ZIP entry before ExcelJS expands the archive. This deliberately
// rejects ZIP64/encrypted archives and spreadsheets with huge sparse dimensions.
function validateWorkbookArchive(buffer: Buffer) {
  let end = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65557);
    i--
  ) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) return invalid("XLSX must be a valid unencrypted workbook");
  const count = buffer.readUInt16LE(end + 10),
    directorySize = buffer.readUInt32LE(end + 12),
    directoryOffset = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0 ||
    count !== buffer.readUInt16LE(end + 8) ||
    count === 0 ||
    count > 512 ||
    directoryOffset + directorySize !== end
  )
    return invalid("Unsupported or oversized workbook archive");
  let offset = directoryOffset,
    total = 0;
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50)
      return invalid("Invalid workbook archive");
    const flags = buffer.readUInt16LE(offset + 8),
      method = buffer.readUInt16LE(offset + 10),
      compressed = buffer.readUInt32LE(offset + 20),
      inflated = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28),
      extraLength = buffer.readUInt16LE(offset + 30),
      commentLength = buffer.readUInt16LE(offset + 32),
      localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) return invalid("Invalid workbook archive");
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (
      names.has(name) ||
      name.includes("..") ||
      name.includes("\\") ||
      name.startsWith("/") ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      /vbaproject|macrosheets|embeddings\//i.test(name)
    )
      return invalid(
        "Macros, embedded objects, encrypted or invalid workbooks are not accepted",
      );
    names.add(name);
    total += inflated;
    if (
      total > MAX_INFLATED_BYTES ||
      localOffset + 30 > directoryOffset ||
      buffer.readUInt32LE(localOffset) !== 0x04034b50
    )
      return invalid("Workbook exceeds the 20 MB expanded size limit");
    const localNameLength = buffer.readUInt16LE(localOffset + 26),
      localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (
      start + compressed > directoryOffset ||
      buffer.readUInt16LE(localOffset + 8) !== method ||
      buffer.readUInt16LE(localOffset + 6) !== flags ||
      buffer
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .toString("utf8") !== name
    )
      return invalid("Invalid workbook archive");
    let content: Buffer;
    try {
      content =
        method === 0
          ? buffer.subarray(start, start + compressed)
          : inflateRawSync(buffer.subarray(start, start + compressed), {
              maxOutputLength: Math.max(
                1,
                Math.min(inflated, MAX_INFLATED_BYTES),
              ),
            });
    } catch {
      return invalid(
        "Workbook entry exceeds its declared size or cannot be expanded",
      );
    }
    if (content.length !== inflated)
      return invalid("Invalid workbook entry size");
    if (name.endsWith(".xml")) {
      const xml = content.toString("utf8");
      if (/<!DOCTYPE|<!ENTITY/i.test(xml))
        return invalid("Workbook contains unsupported XML declarations");
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) {
        if ((xml.match(/<row\b/g) ?? []).length > MAX_ROWS + 1)
          return invalid("At most 2,000 data rows can be imported in one file");
        for (const match of xml.matchAll(
          /\br\s*=\s*["'](?:([A-Z]+))?(\d+)["']/g,
        )) {
          if (
            Number(match[2]) > MAX_ROWS + 1 ||
            (match[1] && columnNumber(match[1]) > MAX_COLUMNS)
          )
            return invalid("Workbook rows or columns exceed the import limits");
        }
        for (const match of xml.matchAll(
          /\bref\s*=\s*["']([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?["']/g,
        )) {
          if (
            columnNumber(match[1]!) > MAX_COLUMNS ||
            Number(match[2]) > MAX_ROWS + 1 ||
            (match[3] && columnNumber(match[3]) > MAX_COLUMNS) ||
            Number(match[4] ?? 0) > MAX_ROWS + 1
          )
            return invalid("Workbook dimensions exceed the import limits");
        }
      }
    }
    offset = next;
  }
  if (
    offset !== end ||
    !names.has("[Content_Types].xml") ||
    !names.has("xl/workbook.xml")
  )
    return invalid("XLSX workbook contents are missing or invalid");
}
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      return invalid("Workbook contains an invalid date");
    return value.toISOString();
  }
  if ("richText" in value) return value.richText.map((t) => t.text).join("");
  if ("text" in value) return value.text;
  if ("formula" in value || "sharedFormula" in value)
    return value.result === undefined
      ? ""
      : cellText(value.result as ExcelJS.CellValue);
  return "";
}
export async function parseImportFile(name: string, buffer: Buffer) {
  if (!buffer.length || buffer.length > MAX_FILE_BYTES)
    return invalid("File must contain data and be at most 5 MB");
  if (/\.csv$/i.test(name)) return parseCsv(buffer);
  if (!/\.xlsx$/i.test(name))
    return invalid(
      "Choose a CSV or XLSX file; legacy XLS and macro workbooks are not supported",
    );
  validateWorkbookArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
  } catch {
    return invalid("XLSX workbook could not be read");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return invalid("Workbook must contain a worksheet");
  if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > MAX_COLUMNS)
    return invalid("Workbook rows or columns exceed the import limits");
  const matrix: string[][] = [];
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber),
      values: string[] = [];
    // Keep interior/trailing blank cells aligned with their column headers.
    for (let col = 1; col <= sheet.columnCount; col++)
      values.push(cellText(row.getCell(col).value));
    matrix.push(values);
  }
  return headersAndRows(matrix);
}
