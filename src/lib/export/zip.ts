/**
 * 极简 ZIP 打包器（仅 store 模式，不压缩）。
 *
 * 为什么自己写：为了导出"真实工程结构"（index.html + app-runtime.js + spec.json + README.md），
 * 而引入 archiver / jszip 之类的依赖会显著增加体积，且本项目只需要最基本的打包能力。
 * 体积代价可接受：工程源码本身只有几十 KB，不做压缩也无妨。
 *
 * 格式依据：PKWARE APPNOTE —— 本地文件头 + 数据 + 中央目录 + EOCD。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** 归档内的路径，使用正斜杠 */
  name: string
  content: string | Uint8Array
}

/** ZIP 使用 DOS 时间格式（1980 起算）。固定时间戳以保证同一输入产出**可复现**的字节。 */
const DOS_TIME = 0 // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1 // 2026-01-01

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : Buffer.from(entry.content)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本
    local.writeUInt16LE(0, 6) // 通用标志位
    local.writeUInt16LE(0, 8) // 压缩方法：0 = store
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // 压缩后大小
    local.writeUInt32LE(data.length, 22) // 原始大小
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // 中央目录签名
    central.writeUInt16LE(20, 4) // 创建版本
    central.writeUInt16LE(20, 6) // 解压所需版本
    central.writeUInt16LE(0, 8) // 标志位
    central.writeUInt16LE(0, 10) // 压缩方法
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // 扩展字段
    central.writeUInt16LE(0, 32) // 注释
    central.writeUInt16LE(0, 34) // 起始磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性
    central.writeUInt32LE(offset, 42) // 本地文件头偏移
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // EOCD 签名
  eocd.writeUInt16LE(0, 4) // 当前磁盘号
  eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16) // 中央目录偏移
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd])
}

export interface ZipReadResult {
  entries: Array<{ name: string; content: Buffer; crcOk: boolean }>
  valid: boolean
  error?: string
}

/**
 * 极简 ZIP 读取器 —— 仅用于测试：验证我们写出的包结构合法、CRC 正确、条目完整。
 * 不追求完备（不处理压缩、加密、ZIP64）。
 */
export function readZip(buf: Buffer): ZipReadResult {
  const entries: ZipReadResult['entries'] = []
  // 从尾部找 EOCD
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) return { entries, valid: false, error: '找不到 EOCD 记录' }

  const total = buf.readUInt16LE(eocdOffset + 10)
  let cdOffset = buf.readUInt32LE(eocdOffset + 16)
  const cdSize = buf.readUInt32LE(eocdOffset + 12)
  if (cdOffset + cdSize > buf.length) return { entries, valid: false, error: '中央目录越界' }

  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) {
      return { entries, valid: false, error: `第 ${i} 个中央目录项签名错误` }
    }
    const crc = buf.readUInt32LE(cdOffset + 16)
    const size = buf.readUInt32LE(cdOffset + 24)
    const nameLen = buf.readUInt16LE(cdOffset + 28)
    const extraLen = buf.readUInt16LE(cdOffset + 30)
    const commentLen = buf.readUInt16LE(cdOffset + 32)
    const localOffset = buf.readUInt32LE(cdOffset + 42)
    const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8')

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      return { entries, valid: false, error: `${name} 的本地文件头签名错误` }
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const content = buf.subarray(dataStart, dataStart + size)

    entries.push({ name, content: Buffer.from(content), crcOk: crc32(content) === crc })
    cdOffset += 46 + nameLen + extraLen + commentLen
  }

  return { entries, valid: entries.length === total && entries.every((e) => e.crcOk) }
}
