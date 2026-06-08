import { gzipSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  extractAuthJsonFilesFromArchive,
  isSupportedAuthFileUploadName,
} from './archiveUpload';

const fileFromBytes = (name: string, bytes: Uint8Array, type = 'application/octet-stream') =>
  new File([new Blob([copyBytesToArrayBuffer(bytes)], { type })], name, { type });

const copyBytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
};

const textFilePayload = async (file: File) => file.text();

const writeAscii = (target: Uint8Array, offset: number, length: number, value: string) => {
  const bytes = strToU8(value);
  target.set(bytes.subarray(0, length), offset);
};

const writeTarOctal = (target: Uint8Array, offset: number, length: number, value: number) => {
  const text = value.toString(8).padStart(length - 1, '0');
  writeAscii(target, offset, length, `${text}\0`);
};

const buildTarEntry = (name: string, content: string): Uint8Array => {
  const payload = strToU8(content);
  const payloadBlocks = Math.ceil(payload.length / 512);
  const entry = new Uint8Array(512 + payloadBlocks * 512);
  writeAscii(entry, 0, 100, name);
  writeTarOctal(entry, 100, 8, 0o644);
  writeTarOctal(entry, 108, 8, 0);
  writeTarOctal(entry, 116, 8, 0);
  writeTarOctal(entry, 124, 12, payload.length);
  writeTarOctal(entry, 136, 12, 0);
  entry.fill(0x20, 148, 156);
  writeAscii(entry, 156, 1, '0');
  writeAscii(entry, 257, 6, 'ustar');
  entry.set(payload, 512);

  const checksum = entry.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  writeTarOctal(entry, 148, 8, checksum);
  return entry;
};

const buildTar = (entries: Array<{ name: string; content: string }>): Uint8Array => {
  const entryBytes = entries.map((entry) => buildTarEntry(entry.name, entry.content));
  const totalLength = entryBytes.reduce((sum, bytes) => sum + bytes.length, 1024);
  const tar = new Uint8Array(totalLength);
  let offset = 0;
  entryBytes.forEach((bytes) => {
    tar.set(bytes, offset);
    offset += bytes.length;
  });
  return tar;
};

describe('auth file archive upload helpers', () => {
  it('accepts JSON files and common JSON archive names', () => {
    expect(isSupportedAuthFileUploadName('auth.json')).toBe(true);
    expect(isSupportedAuthFileUploadName('auth.zip')).toBe(true);
    expect(isSupportedAuthFileUploadName('auth.tar')).toBe(true);
    expect(isSupportedAuthFileUploadName('auth.tar.gz')).toBe(true);
    expect(isSupportedAuthFileUploadName('auth.tgz')).toBe(true);
    expect(isSupportedAuthFileUploadName('auth.json.gz')).toBe(true);
    expect(isSupportedAuthFileUploadName('auth.txt')).toBe(false);
  });

  it('extracts JSON files from zip archives and skips non-JSON entries', async () => {
    const zip = zipSync({
      'codex/auth-a.json': strToU8('{"type":"codex","access_token":"a"}'),
      'notes.txt': strToU8('ignore me'),
    });

    const result = await extractAuthJsonFilesFromArchive(
      fileFromBytes('auth-files.zip', zip, 'application/zip')
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('auth-a.json');
    await expect(textFilePayload(result.files[0])).resolves.toBe(
      '{"type":"codex","access_token":"a"}'
    );
    expect(result.skippedEntries).toContain('notes.txt');
  });

  it('deduplicates repeated JSON base names inside zip archives', async () => {
    const zip = zipSync({
      'first/auth.json': strToU8('{"token":"first"}'),
      'second/auth.json': strToU8('{"token":"second"}'),
    });

    const result = await extractAuthJsonFilesFromArchive(fileFromBytes('auth-files.zip', zip));

    expect(result.files.map((file) => file.name)).toEqual(['auth.json', 'auth-2.json']);
  });

  it('extracts JSON files from tar gzip archives', async () => {
    const tar = buildTar([
      { name: 'nested/auth-b.json', content: '{"type":"codex","access_token":"b"}' },
      { name: 'nested/readme.md', content: 'ignore me' },
    ]);

    const result = await extractAuthJsonFilesFromArchive(
      fileFromBytes('auth-files.tgz', gzipSync(tar), 'application/gzip')
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('auth-b.json');
    await expect(textFilePayload(result.files[0])).resolves.toBe(
      '{"type":"codex","access_token":"b"}'
    );
  });

  it('extracts a gzipped single JSON file', async () => {
    const result = await extractAuthJsonFilesFromArchive(
      fileFromBytes(
        'single-auth.json.gz',
        gzipSync(strToU8('{"type":"codex","access_token":"single"}')),
        'application/gzip'
      )
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('single-auth.json');
    await expect(textFilePayload(result.files[0])).resolves.toBe(
      '{"type":"codex","access_token":"single"}'
    );
  });
});
