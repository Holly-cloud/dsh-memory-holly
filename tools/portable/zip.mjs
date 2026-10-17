/**
 * dsh-memory · 零依赖 ZIP 写入/读取（只依赖 `node:zlib`）。
 *
 * 为什么手写：发包工具要在**任何设备**上都能产出 zip —— 不走 `Compress-Archive`（只在
 * Windows），也不引第三方包（本项目的铁律是零第三方依赖）。这里只实现打包需要的子集：
 * store / deflate 两种方法、UTF-8 文件名、单卷、无 zip64（>4 GB 或 >65535 个文件会直接报错，
 * 而不是写出坏包）。
 *
 * 读回函数是给**自检**用的：打包器写完 zip 后自己解开逐个核对，比"看起来像 zip"可靠。
 *
 * @module dsh-memory/tools/portable/zip
 */
import { writeFileSync } from 'node:fs';

import { inflateRawSync, deflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** CRC32 查表（多项式 0xEDB88320）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/**
 * 计算 CRC32。
 *
 * @param {Buffer} buffer 数据
 * @returns {number} 无符号 32 位 CRC
 */
export function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * 把 Date 转成 DOS 时间/日期（zip 的 2 秒精度）。
 *
 * @param {Date} date 时间
 * @returns {{ time: number, date: number }} DOS 字段
 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 打包成 zip 文件。
 *
 * @param {string} file 目标 zip 路径（父目录需已存在）
 * @param {{ name: string, data: Buffer, mtime?: Date }[]} entries 条目（name 用正斜杠）
 * @returns {{ file: string, entries: number, bytes: number }} 结果
 */
export function writeZip(file, entries) {
  if (entries.length > 65535) throw new Error(`条目过多（${entries.length} > 65535），本实现不支持 zip64`);
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {{ name: Buffer, crc: number, compSize: number, rawSize: number, offset: number, method: number, time: number, date: number }[]} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, body);
    central.push({
      name,
      crc,
      compSize: body.length,
      rawSize: raw.length,
      offset,
      method: useDeflate ? 8 : 0,
      time,
      date,
    });
    offset += local.length + name.length + body.length;
  }

  const centralStart = offset;
  for (const item of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIG, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(item.method, 10);
    header.writeUInt16LE(item.time, 12);
    header.writeUInt16LE(item.date, 14);
    header.writeUInt32LE(item.crc, 16);
    header.writeUInt32LE(item.compSize, 20);
    header.writeUInt32LE(item.rawSize, 24);
    header.writeUInt16LE(item.name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(item.offset, 42);
    chunks.push(header, item.name);
    offset += header.length + item.name.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  const all = Buffer.concat(chunks);
  writeFileSync(file, all);
  return { file, entries: entries.length, bytes: all.length };
}

/**
 * 读回 zip（只支持本模块写出的子集：store / deflate、无 zip64、无加密）。
 *
 * @param {Buffer} buffer zip 内容
 * @returns {{ name: string, data: Buffer }[]} 条目
 */
export function readZip(buffer) {
  // 从尾部往前找 EOCD（注释最长 65535，所以最多扫这么多）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('不是 zip：找不到 EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);

  /** @type {{ name: string, data: Buffer }[]} */
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(ptr) !== CENTRAL_SIG) throw new Error(`第 ${i} 个中央目录项签名不对`);
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`「${name}」本地头签名不对`);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const body = buffer.subarray(dataStart, dataStart + compSize);
    out.push({ name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body) });
  }
  return out;
}
