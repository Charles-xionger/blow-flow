import { inflateRawSync } from 'node:zlib';
import { SkillUploadError } from './skills';
import { formatSkillUploadLimit, getSkillUploadLimits } from './skill-upload-limits';

const maximumFiles = 200;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;
const endSignature = 0x06054b50;

type ArchiveEntry = {
    name: string;
    compressedSize: number;
    size: number;
    crc: number;
    compression: number;
    flags: number;
    localOffset: number;
    directory: boolean;
};

export type SkillArchive = { markdown: string; resources: Map<string, Buffer> };

function unsafePath(name: string) {
    const segments = name.split('/');
    return name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)
        || segments.some(segment => segment === '..' || segment === '.') || segments.some((segment, index) => !segment && index < segments.length - 1);
}

function decodeName(bytes: Buffer) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new SkillUploadError('ZIP 条目名称必须使用 UTF-8 编码');
    }
}

function findEnd(buffer: Buffer) {
    const minimum = Math.max(0, buffer.length - 65_557);
    for (let offset = buffer.length - 22; offset >= minimum; offset--) {
        if (buffer.readUInt32LE(offset) === endSignature) return offset;
    }
    throw new SkillUploadError('ZIP 文件格式无效');
}

function inspectArchive(buffer: Buffer): ArchiveEntry[] {
    const limits = getSkillUploadLimits();
    const end = findEnd(buffer);
    const disk = buffer.readUInt16LE(end + 4);
    const centralDisk = buffer.readUInt16LE(end + 6);
    const diskEntries = buffer.readUInt16LE(end + 8);
    const entryCount = buffer.readUInt16LE(end + 10);
    const centralSize = buffer.readUInt32LE(end + 12);
    const centralOffset = buffer.readUInt32LE(end + 16);
    if (disk || centralDisk || diskEntries !== entryCount || entryCount === 0 || entryCount === 0xffff
        || centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize > end) {
        throw new SkillUploadError('ZIP 文件格式不受支持');
    }

    const entries: ArchiveEntry[] = [];
    const names = new Set<string>();
    let offset = centralOffset;
    for (let index = 0; index < entryCount; index++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== centralSignature) throw new SkillUploadError('ZIP 文件格式无效');
        const versionMadeBy = buffer.readUInt16LE(offset + 4);
        const flags = buffer.readUInt16LE(offset + 8);
        const compression = buffer.readUInt16LE(offset + 10);
        const crc = buffer.readUInt32LE(offset + 16);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const size = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const externalAttributes = buffer.readUInt32LE(offset + 38);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const next = offset + 46 + nameLength + extraLength + commentLength;
        if (next > buffer.length || compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
            throw new SkillUploadError('ZIP 文件格式不受支持');
        }
        const name = decodeName(buffer.subarray(offset + 46, offset + 46 + nameLength));
        if (!name || unsafePath(name)) throw new SkillUploadError(`ZIP 包含不安全路径：${name || '(空路径)'}`);
        if (names.has(name)) throw new SkillUploadError(`ZIP 包含重复路径：${name}`);
        names.add(name);
        if (flags & 1) throw new SkillUploadError('ZIP 不能包含加密条目');
        if (compression !== 0 && compression !== 8) throw new SkillUploadError('ZIP 包含不支持的压缩格式');
        const unixMode = (versionMadeBy >> 8) === 3 ? externalAttributes >>> 16 : 0;
        if ((unixMode & 0o170000) === 0o120000) throw new SkillUploadError('ZIP 不能包含符号链接');
        const directory = name.endsWith('/');
        const unixType = unixMode & 0o170000;
        if (unixType && unixType !== 0o100000 && !(directory && unixType === 0o040000)) {
            throw new SkillUploadError('ZIP 不能包含特殊文件条目');
        }
        if (!directory && (compressedSize > limits.fileBytes || size > limits.fileBytes)) {
            throw new SkillUploadError(`ZIP 中单个文件不能超过 ${formatSkillUploadLimit(limits.fileMb)}`, 413);
        }
        entries.push({ name, compressedSize, size, crc, compression, flags, localOffset, directory });
        offset = next;
    }
    if (offset !== centralOffset + centralSize) throw new SkillUploadError('ZIP 中央目录格式无效');
    const files = entries.filter(entry => !entry.directory);
    if (files.length > maximumFiles) throw new SkillUploadError('ZIP 最多包含 200 个文件', 413);
    if (files.reduce((sum, entry) => sum + entry.compressedSize, 0) > limits.packageBytes) {
        throw new SkillUploadError(`ZIP 压缩内容不能超过 ${formatSkillUploadLimit(limits.packageMb)}`, 413);
    }
    if (files.reduce((sum, entry) => sum + entry.size, 0) > limits.expandedBytes) {
        throw new SkillUploadError(`ZIP 解压后不能超过 ${formatSkillUploadLimit(limits.expandedMb)}`, 413);
    }
    return files;
}

function crc32(buffer: Buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function extractEntry(archive: Buffer, entry: ArchiveEntry) {
    const limits = getSkillUploadLimits();
    const offset = entry.localOffset;
    if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== localSignature) throw new SkillUploadError('ZIP 本地条目格式无效');
    const localFlags = archive.readUInt16LE(offset + 6);
    const localCompression = archive.readUInt16LE(offset + 8);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const end = dataOffset + entry.compressedSize;
    if (end > archive.length || localFlags !== entry.flags || localCompression !== entry.compression) throw new SkillUploadError('ZIP 本地条目与中央目录不一致');
    const localName = decodeName(archive.subarray(offset + 30, offset + 30 + nameLength));
    if (localName !== entry.name) throw new SkillUploadError('ZIP 本地条目路径与中央目录不一致');
    const compressed = archive.subarray(dataOffset, end);
    let content: Buffer;
    try {
        content = entry.compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: limits.fileBytes + 1 });
    } catch {
        throw new SkillUploadError(`ZIP 条目无法安全解压：${entry.name}`);
    }
    if (content.length !== entry.size || content.length > limits.fileBytes || crc32(content) !== entry.crc) {
        throw new SkillUploadError(`ZIP 条目校验失败：${entry.name}`);
    }
    return content;
}

export function parseSkillArchive(archive: Buffer): SkillArchive {
    const limits = getSkillUploadLimits();
    if (archive.length > limits.packageBytes) throw new SkillUploadError(`ZIP 包不能超过 ${formatSkillUploadLimit(limits.packageMb)}`, 413);
    const entries = inspectArchive(archive);
    const skillEntries = entries.filter(entry => entry.name.split('/').at(-1) === 'SKILL.md');
    if (!skillEntries.length) throw new SkillUploadError('ZIP 必须包含一个 SKILL.md');
    if (skillEntries.length !== 1) throw new SkillUploadError('ZIP 只能包含一个 SKILL.md');
    const skillEntry = skillEntries[0];
    const parts = skillEntry.name.split('/');
    if (parts.length > 2) throw new SkillUploadError('SKILL.md 必须位于根目录或仅外包一层目录');
    const wrapper = parts.length === 2 ? parts[0] : undefined;
    if (wrapper && entries.some(entry => !entry.name.startsWith(`${wrapper}/`))) {
        throw new SkillUploadError('外包目录中的 ZIP 不能包含目录外文件');
    }

    const extracted = new Map<string, Buffer>();
    let total = 0;
    for (const entry of entries) {
        const content = extractEntry(archive, entry);
        total += content.length;
        if (total > limits.expandedBytes) throw new SkillUploadError(`ZIP 解压后不能超过 ${formatSkillUploadLimit(limits.expandedMb)}`, 413);
        extracted.set(wrapper ? entry.name.slice(wrapper.length + 1) : entry.name, content);
    }
    const markdownBuffer = extracted.get('SKILL.md');
    if (!markdownBuffer) throw new SkillUploadError('ZIP 必须包含一个 SKILL.md');
    let markdown: string;
    try {
        markdown = new TextDecoder('utf-8', { fatal: true }).decode(markdownBuffer);
    } catch {
        throw new SkillUploadError('SKILL.md 必须使用 UTF-8 编码');
    }
    extracted.delete('SKILL.md');
    return { markdown, resources: extracted };
}
