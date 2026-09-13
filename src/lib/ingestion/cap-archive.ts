import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";

// Read regular CAP files in memory only. No archive entry is written to disk.
export function readCapArchive(compressed: Uint8Array): Array<{ name: string; xml: string }> {
  if (compressed.byteLength > 1024 * 1024) throw new Error("CAP compressed archive exceeds 1 MiB");
  const data = gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 });
  const files: Array<{ name: string; xml: string }> = [];
  const names = new Set<string>();
  const string = (header: Buffer, start: number, end: number) => header.subarray(start, end).toString("utf8").split("\0")[0];
  const octal = (header: Buffer, start: number, end: number) => {
    const value = string(header, start, end).trim();
    if (!/^[0-7]+$/.test(value)) throw new Error("Invalid CAP tar numeric field");
    return Number.parseInt(value, 8);
  };
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (data.length - offset < 1024 || data.subarray(offset).some((byte) => byte !== 0)) throw new Error("Invalid CAP tar terminator");
      return files;
    }
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== octal(header, 148, 156)) throw new Error("CAP tar checksum mismatch");
    const name = string(header, 0, 100);
    const size = octal(header, 124, 136);
    if (![0, 48].includes(header[156]) || string(header, 157, 257) || string(header, 345, 500)
      || !/^Z_CAP_C_LEMM_[A-Za-z0-9_.-]+\.xml$/.test(name) || name.includes("..") || names.has(name)) {
      throw new Error("Unsupported or duplicate CAP tar entry");
    }
    if (size < 1 || size > 512 * 1024 || files.length >= 1000) throw new Error("CAP tar entry limit exceeded");
    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > data.length) throw new Error("Truncated CAP tar entry");
    files.push({ name, xml: new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset + 512, end)) });
    names.add(name);
    offset = next;
  }
  throw new Error("CAP tar has no complete terminator");
}

/** Read a bounded ZIP without writing archive entries to disk. Central-directory
 * size metadata is rejected before fflate allocates decompressed buffers. */
export function readCapZipArchive(compressed: Uint8Array): Array<{ name: string; xml: string }> {
  if (compressed.byteLength < 22 || compressed.byteLength > 1024 * 1024) throw new Error("CAP ZIP compressed archive exceeds its 1 MiB limit");
  let entries = 0; let decompressed = 0; let compressedEntries = 0;
  const names = new Set<string>();
  const files = unzipSync(compressed, { filter: (file) => {
    entries += 1;
    if (entries > 1_000 || file.originalSize < 1 || file.originalSize > 512 * 1024 || file.size < 1
      || file.originalSize === 0xffffffff || file.size === 0xffffffff || (file.compression === 0 && file.size !== file.originalSize)
      || decompressed + file.originalSize > 8 * 1024 * 1024
      || compressedEntries + file.size > 1024 * 1024
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.xml$/.test(file.name) || file.name.includes("..") || names.has(file.name)
      || ![0, 8].includes(file.compression)) throw new Error("Unsafe or excessive CAP ZIP entry");
    names.add(file.name); decompressed += file.originalSize; compressedEntries += file.size;
    return true;
  } });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let actualTotal = 0;
  return Object.entries(files).map(([name, bytes]) => {
    actualTotal += bytes.byteLength;
    if (bytes.byteLength < 1 || bytes.byteLength > 512 * 1024 || actualTotal > 8 * 1024 * 1024) throw new Error("Unsafe or excessive CAP ZIP output");
    return { name, xml: decoder.decode(bytes) };
  });
}
