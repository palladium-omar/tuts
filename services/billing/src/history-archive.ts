// Adapted from the Clients bounded ZIP validator. Kept local to preserve service boundaries.
import { BadRequestException } from '@nestjs/common';
import { inflateArchiveEntry } from '@palladium/service-kit/archive-inflate';
const MAX_ROWS = 2000;
const MAX_COLUMNS = 100;
const MAX_INFLATED_BYTES = 20 * 1024 * 1024;
const invalid = (message: string): never => { throw new BadRequestException(message); };
function columnNumber(letters: string) {
  let n = 0;
  for (const c of letters) n = n * 26 + c.charCodeAt(0) - 64;
  return n;
}
// Validate every ZIP entry before ExcelJS expands the archive. This deliberately
// rejects ZIP64/encrypted archives and spreadsheets with huge sparse dimensions.
export async function validateWorkbookArchive(buffer: Buffer) {
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
          : await inflateArchiveEntry(buffer.subarray(start, start + compressed), inflated);
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
