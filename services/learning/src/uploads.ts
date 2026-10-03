import { BadRequestException } from "@nestjs/common";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export type UploadedResourceFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};
const mimeByExtension: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
};
/** Validate a bounded, unencrypted ordinary Office ZIP without extracting it to disk. */
function validOfficeZip(bytes: Buffer, kind: "docx" | "pptx"): boolean {
  try {
    let end = -1;
    for (
      let i = bytes.length - 22;
      i >= Math.max(0, bytes.length - 65557);
      i--
    ) {
      if (
        bytes.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
      ) {
        end = i;
        break;
      }
    }
    if (
      end < 0 ||
      bytes.readUInt16LE(end + 4) !== 0 ||
      bytes.readUInt16LE(end + 6) !== 0
    )
      return false;
    const count = bytes.readUInt16LE(end + 10),
      directorySize = bytes.readUInt32LE(end + 12),
      directoryOffset = bytes.readUInt32LE(end + 16);
    if (
      !count ||
      count > 1000 ||
      count !== bytes.readUInt16LE(end + 8) ||
      directoryOffset + directorySize !== end
    )
      return false;
    let offset = directoryOffset,
      expanded = 0;
    const names = new Set<string>();
    const required =
      kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
        return false;
      const flags = bytes.readUInt16LE(offset + 8),
        method = bytes.readUInt16LE(offset + 10),
        compressed = bytes.readUInt32LE(offset + 20),
        size = bytes.readUInt32LE(offset + 24);
      const nameLength = bytes.readUInt16LE(offset + 28),
        extraLength = bytes.readUInt16LE(offset + 30),
        commentLength = bytes.readUInt16LE(offset + 32),
        local = bytes.readUInt32LE(offset + 42);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (
        next > end ||
        flags & 1 ||
        ![0, 8].includes(method) ||
        bytes.readUInt16LE(offset + 34) !== 0 ||
        local + 30 > directoryOffset
      )
        return false;
      const name = bytes.toString(
        "utf8",
        offset + 46,
        offset + 46 + nameLength,
      );
      if (
        !name ||
        names.has(name) ||
        name.includes("\0") ||
        name.includes("\\") ||
        name.startsWith("/") ||
        name.split("/").includes("..") ||
        /vbaproject|\.exe$|\.dll$/i.test(name)
      )
        return false;
      names.add(name);
      expanded += size;
      if (
        size > MAX_UPLOAD_BYTES ||
        expanded > 50 * 1024 * 1024 ||
        size > Math.max(compressed * 200, 1024 * 1024)
      )
        return false;
      if (
        bytes.readUInt32LE(local) !== 0x04034b50 ||
        bytes.readUInt16LE(local + 6) !== flags ||
        bytes.readUInt16LE(local + 8) !== method
      )
        return false;
      const localNameLength = bytes.readUInt16LE(local + 26),
        localExtraLength = bytes.readUInt16LE(local + 28);
      if (
        bytes.toString("utf8", local + 30, local + 30 + localNameLength) !==
        name
      )
        return false;
      const data = local + 30 + localNameLength + localExtraLength;
      if (data + compressed > directoryOffset) return false;
      // Inflate with a hard output bound so forged size fields cannot hide a ZIP bomb.
      const content =
        method === 8
          ? inflateRawSync(bytes.subarray(data, data + compressed), {
              maxOutputLength: Math.max(size, 1),
            })
          : bytes.subarray(data, data + compressed);
      if (content.length !== size) return false;
      if (
        (name === "[Content_Types].xml" || name === required) &&
        (!size || !content.toString("utf8").includes("<"))
      )
        return false;
      offset = next;
    }
    return (
      offset === end &&
      names.has("[Content_Types].xml") &&
      names.has("_rels/.rels") &&
      names.has(required)
    );
  } catch {
    return false;
  }
}
export function validateUpload(file: UploadedResourceFile | undefined): {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
} {
  if (!file?.buffer?.length)
    throw new BadRequestException("A nonempty file is required");
  if (file.buffer.length > MAX_UPLOAD_BYTES)
    throw new BadRequestException("Files must be at most 20 MiB");
  const fileName = file.originalname
    .replace(/\\/g, "/")
    .split("/")
    .at(-1)!
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (!fileName || fileName.length > 255)
    throw new BadRequestException("File name must contain 1–255 characters");
  const extension = extname(fileName).toLowerCase(),
    mimeType = mimeByExtension[extension],
    bytes = file.buffer;
  if (!mimeType)
    throw new BadRequestException(
      "Supported files: PDF, PNG, JPEG, WebP, DOCX, PPTX and TXT",
    );
  let valid = false;
  if (extension === ".pdf")
    valid =
      bytes.length >= 8 &&
      /^%PDF-1\.[0-9]|^%PDF-2\.0/.test(bytes.toString("ascii", 0, 8)) &&
      bytes
        .subarray(Math.max(0, bytes.length - 2048))
        .includes(Buffer.from("%%EOF"));
  else if (extension === ".png")
    valid =
      bytes.length >= 24 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString("ascii", 12, 16) === "IHDR";
  else if (extension === ".jpg" || extension === ".jpeg")
    valid =
      bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255 &&
      bytes[bytes.length - 2] === 255 &&
      bytes[bytes.length - 1] === 217;
  else if (extension === ".webp")
    valid =
      bytes.length >= 16 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
      bytes.readUInt32LE(4) + 8 === bytes.length;
  else if (extension === ".docx" || extension === ".pptx")
    valid = validOfficeZip(bytes, extension.slice(1) as "docx" | "pptx");
  else if (extension === ".txt") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      valid =
        !bytes.includes(0) &&
        !bytes.some((v) => v < 32 && ![9, 10, 13].includes(v));
    } catch {
      valid = false;
    }
  }
  if (!valid)
    throw new BadRequestException(
      "File contents do not match a supported format or exceed archive safety limits",
    );
  return { fileName, mimeType, buffer: bytes };
}
