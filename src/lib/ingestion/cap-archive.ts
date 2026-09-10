import { gunzipSync } from "node:zlib";

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
