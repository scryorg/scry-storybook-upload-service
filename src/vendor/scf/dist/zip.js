/**
 * Minimal ZIP reader for the CLI only (`scf validate some.zip`). Uses `node:zlib` for inflate — the
 * one runtime dependency the contract allows, and only here: the library entry (index.ts) never
 * imports this module, so a Worker or browser build of `@scrymore/scf` stays zero-dependency.
 *
 * Supports STORED (0) and DEFLATE (8) members, which is everything `archiver` (sbcov) and every
 * SCF adapter in this repo produce.
 */
import { inflateRawSync } from 'node:zlib';
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
function findEndOfCentralDirectory(buf) {
    const start = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
    for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIGNATURE)
            return i;
    }
    throw new Error('Not a valid ZIP file (no end-of-central-directory record found).');
}
/** Parses a ZIP buffer into a bundle-relative path -> bytes map. Directory entries are skipped. */
export function readZip(buf) {
    const files = new Map();
    const eocd = findEndOfCentralDirectory(buf);
    const entryCount = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < entryCount; i++) {
        if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
            throw new Error(`Corrupt ZIP central directory entry at offset ${offset}.`);
        }
        const compressionMethod = buf.readUInt16LE(offset + 10);
        const compressedSize = buf.readUInt32LE(offset + 20);
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const localHeaderOffset = buf.readUInt32LE(offset + 42);
        const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
        if (!name.endsWith('/')) {
            files.set(name, readLocalEntry(buf, localHeaderOffset, compressionMethod, compressedSize));
        }
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}
function readLocalEntry(buf, localHeaderOffset, compressionMethod, compressedSize) {
    if (buf.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
        throw new Error(`Corrupt ZIP local file header at offset ${localHeaderOffset}.`);
    }
    const nameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const extraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + nameLen + extraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    if (compressionMethod === 0)
        return new Uint8Array(compressed);
    if (compressionMethod === 8)
        return new Uint8Array(inflateRawSync(compressed));
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}
//# sourceMappingURL=zip.js.map