import { gunzipSync, unzipSync } from 'fflate';

const JSON_FILE_EXTENSION = '.json';
const ZIP_FILE_EXTENSION = '.zip';
const TAR_FILE_EXTENSION = '.tar';
const GZIP_FILE_EXTENSIONS = ['.gz', '.gzip'] as const;
const TAR_GZIP_FILE_EXTENSIONS = ['.tar.gz', '.tgz'] as const;
const UPLOAD_FILE_TYPE = 'application/json';
const TAR_BLOCK_SIZE = 512;
const UNSAFE_FILE_NAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

export const AUTH_FILE_UPLOAD_ACCEPT =
  '.json,application/json,.zip,application/zip,application/x-zip-compressed,.tar,application/x-tar,.tgz,.tar.gz,.gz,.gzip,application/gzip';

export type ExtractedAuthFileArchive = {
  files: File[];
  skippedEntries: string[];
};

const textDecoder = new TextDecoder();

const lowerName = (name: string) => name.trim().toLowerCase();

export const isAuthFileJsonName = (name: string): boolean =>
  lowerName(name).endsWith(JSON_FILE_EXTENSION);

const hasAnyExtension = (name: string, extensions: readonly string[]) => {
  const normalized = lowerName(name);
  return extensions.some((extension) => normalized.endsWith(extension));
};

const isTarGzipArchiveName = (name: string): boolean =>
  hasAnyExtension(name, TAR_GZIP_FILE_EXTENSIONS);

const isGzipArchiveName = (name: string): boolean =>
  hasAnyExtension(name, GZIP_FILE_EXTENSIONS);

export const isAuthFileArchiveName = (name: string): boolean => {
  const normalized = lowerName(name);
  return (
    normalized.endsWith(ZIP_FILE_EXTENSION) ||
    normalized.endsWith(TAR_FILE_EXTENSION) ||
    isTarGzipArchiveName(normalized) ||
    isGzipArchiveName(normalized)
  );
};

export const isSupportedAuthFileUploadName = (name: string): boolean =>
  isAuthFileJsonName(name) || isAuthFileArchiveName(name);

const removeKnownArchiveExtension = (name: string): string => {
  const normalized = lowerName(name);
  const extension = [...TAR_GZIP_FILE_EXTENSIONS, ...GZIP_FILE_EXTENSIONS, ZIP_FILE_EXTENSION].find(
    (item) => normalized.endsWith(item)
  );
  if (!extension) return name;
  return name.slice(0, -extension.length);
};

const normalizeArchiveEntryName = (entryName: string): string | null => {
  const normalized = entryName.replace(/\\/g, '/');
  const baseName = normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .pop();
  if (!baseName || !isAuthFileJsonName(baseName)) return null;
  return Array.from(baseName)
    .map((char) => (UNSAFE_FILE_NAME_CHARS.has(char) || char.charCodeAt(0) < 32 ? '_' : char))
    .join('');
};

const makeUniqueJsonName = (name: string, usedNames: Set<string>): string => {
  const baseName = name.slice(0, -JSON_FILE_EXTENSION.length);
  let nextName = name;
  let index = 2;
  while (usedNames.has(nextName.toLowerCase())) {
    nextName = `${baseName}-${index}${JSON_FILE_EXTENSION}`;
    index++;
  }
  usedNames.add(nextName.toLowerCase());
  return nextName;
};

const toJsonFile = (name: string, bytes: Uint8Array, usedNames: Set<string>): File =>
  new File(
    [new Blob([copyBytesToArrayBuffer(bytes)], { type: UPLOAD_FILE_TYPE })],
    makeUniqueJsonName(name, usedNames),
    {
      type: UPLOAD_FILE_TYPE,
    }
  );

const copyBytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
};

const extractZipJsonFiles = (bytes: Uint8Array): ExtractedAuthFileArchive => {
  const entries = unzipSync(bytes);
  const usedNames = new Set<string>();
  const files: File[] = [];
  const skippedEntries: string[] = [];

  Object.entries(entries).forEach(([entryName, entryBytes]) => {
    const fileName = normalizeArchiveEntryName(entryName);
    if (!fileName) {
      skippedEntries.push(entryName);
      return;
    }
    files.push(toJsonFile(fileName, entryBytes, usedNames));
  });

  return { files, skippedEntries };
};

const readTarText = (bytes: Uint8Array, start: number, length: number): string => {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return textDecoder.decode(end >= 0 ? slice.subarray(0, end) : slice).trim();
};

const readTarSize = (bytes: Uint8Array, start: number): number => {
  const text = readTarText(bytes, start, 12).replace(/\0/g, '').trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
};

const isEmptyTarBlock = (bytes: Uint8Array, offset: number): boolean => {
  for (let index = 0; index < TAR_BLOCK_SIZE; index++) {
    if (bytes[offset + index] !== 0) return false;
  }
  return true;
};

const extractTarJsonFiles = (bytes: Uint8Array): ExtractedAuthFileArchive => {
  const usedNames = new Set<string>();
  const files: File[] = [];
  const skippedEntries: string[] = [];
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= bytes.length) {
    if (isEmptyTarBlock(bytes, offset)) break;

    const name = readTarText(bytes, offset, 100);
    const prefix = readTarText(bytes, offset + 345, 155);
    const entryName = [prefix, name].filter(Boolean).join('/');
    const size = readTarSize(bytes, offset + 124);
    const typeFlag = String.fromCharCode(bytes[offset + 156] || 0);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const isRegularFile = typeFlag === '\0' || typeFlag === '0' || typeFlag === '';

    if (!isRegularFile || dataEnd > bytes.length) {
      if (entryName) skippedEntries.push(entryName);
      offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
      continue;
    }

    const fileName = normalizeArchiveEntryName(entryName);
    if (!fileName) {
      skippedEntries.push(entryName);
    } else {
      files.push(toJsonFile(fileName, bytes.subarray(dataStart, dataEnd), usedNames));
    }

    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return { files, skippedEntries };
};

const deriveGzipJsonFileName = (name: string, bytes: Uint8Array): string | null => {
  const baseName = removeKnownArchiveExtension(name);
  if (isAuthFileJsonName(baseName)) return normalizeArchiveEntryName(baseName);

  try {
    JSON.parse(textDecoder.decode(bytes));
  } catch {
    return null;
  }

  const fallback = normalizeArchiveEntryName(`${baseName || 'auth-file'}${JSON_FILE_EXTENSION}`);
  return fallback;
};

const extractGzipJsonFile = (archiveName: string, bytes: Uint8Array): ExtractedAuthFileArchive => {
  const decompressed = gunzipSync(bytes);
  const fileName = deriveGzipJsonFileName(archiveName, decompressed);
  if (!fileName) {
    return { files: [], skippedEntries: [archiveName] };
  }
  return { files: [toJsonFile(fileName, decompressed, new Set<string>())], skippedEntries: [] };
};

export const extractAuthJsonFilesFromArchive = async (
  file: File
): Promise<ExtractedAuthFileArchive> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const normalized = lowerName(file.name);

  if (normalized.endsWith(ZIP_FILE_EXTENSION)) {
    return extractZipJsonFiles(bytes);
  }

  if (isTarGzipArchiveName(normalized)) {
    return extractTarJsonFiles(gunzipSync(bytes));
  }

  if (normalized.endsWith(TAR_FILE_EXTENSION)) {
    return extractTarJsonFiles(bytes);
  }

  if (isGzipArchiveName(normalized)) {
    return extractGzipJsonFile(file.name, bytes);
  }

  return { files: [], skippedEntries: [file.name] };
};
