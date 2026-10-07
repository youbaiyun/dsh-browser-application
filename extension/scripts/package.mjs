/**
 * Build the two store/release archives from an already-built extension.
 *
 * Two properties matter and are enforced here rather than left to whoever runs
 * the upload by hand:
 *
 * 1. **Entry names use `/`, never `\`.** A store upload containing backslash
 *    entries is rejected. This is why the packer is hand-written instead of
 *    shelling out to `Compress-Archive`: on Windows that cmdlet produces
 *    backslash entries, and `zip` is not present on a stock machine. A ZIP
 *    writer over `node:zlib` keeps the tooling dependency-free and correct on
 *    every platform.
 * 2. **The name carries the version of the manifest inside it**, so a file name
 *    and its contents cannot disagree.
 *
 * Usage (from the repository root, after both builds):
 *   node extension/scripts/package.mjs
 *
 * Writes `dsh-browser-crossplatform-<version>.zip` (Chrome) and
 * `dsh-browser-crossplatform-<version>-firefox.zip` (Firefox) into the repo root.
 */

import { deflateRawSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const extensionDir = resolve(root, 'extension')

/** Date/time fields use the DOS epoch; the build time is the honest value. */
const DOS_EPOCH = new Date(1980, 0, 1).getTime()

/** Read one built manifest and fail loudly rather than shipping a stale dist. */
function readManifest(dir) {
  const file = resolve(extensionDir, dir, 'manifest.json')
  if (!existsSync(file)) {
    throw new Error(`${dir}/manifest.json is missing — build that target first (see README "Commands")`)
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Both target manifests must agree, and that version is the archive name. */
function resolveVersion() {
  const chrome = readManifest('dist')
  const firefox = readManifest('dist-firefox')
  if (chrome.version !== firefox.version) {
    throw new Error(`dist is ${chrome.version} while dist-firefox is ${firefox.version}; rebuild both targets`)
  }
  return chrome.version
}

let crcTable

/** Standard CRC-32 (IEEE 802.3 polynomial), computed lazily. */
function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Every file under `dir`, as `/`-separated names relative to it, sorted. */
function collectFiles(dir, prefix = '') {
  const files = []
  for (const name of readdirSync(dir).sort()) {
    const absolute = resolve(dir, name)
    const entry = prefix === '' ? name : `${prefix}/${name}`
    if (statSync(absolute).isDirectory()) files.push(...collectFiles(absolute, entry))
    else files.push({ entry, absolute })
  }
  return files
}

/** MINIZIP-compatible date/time pair for one mtime. */
function dosDateTime(mtime) {
  const date = new Date(Math.max(mtime, DOS_EPOCH))
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/**
 * Pack one directory into a ZIP buffer.
 * @param {string} sourceDir - absolute directory to pack.
 * @returns {Buffer} the archive.
 */
function packDirectory(sourceDir) {
  const files = collectFiles(sourceDir)
  const local = []
  const central = []
  let offset = 0
  for (const { entry, absolute } of files) {
    if (entry.includes('\\')) throw new Error(`refusing to pack a backslash entry: ${entry}`)
    const name = Buffer.from(entry, 'utf8')
    const content = readFileSync(absolute)
    const deflated = deflateRawSync(content, { level: 9 })
    const crc = crc32(content)
    const { time, day } = dosDateTime(statSync(absolute).mtimeMs)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0) // local file header
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(day, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(deflated.length, 18)
    header.writeUInt32LE(content.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    local.push(header, name, deflated)

    const entryHeader = Buffer.alloc(46)
    entryHeader.writeUInt32LE(0x02014b50, 0) // central directory header
    entryHeader.writeUInt16LE(0x031e, 4) // made by: UNIX, 3.0
    entryHeader.writeUInt16LE(20, 6)
    entryHeader.writeUInt16LE(0x0800, 8)
    entryHeader.writeUInt16LE(8, 10)
    entryHeader.writeUInt16LE(time, 12)
    entryHeader.writeUInt16LE(day, 14)
    entryHeader.writeUInt32LE(crc, 16)
    entryHeader.writeUInt32LE(deflated.length, 20)
    entryHeader.writeUInt32LE(content.length, 24)
    entryHeader.writeUInt16LE(name.length, 28)
    entryHeader.writeUInt32LE(0o100644 * 0x10000, 38) // external attrs: -rw-r--r--
    entryHeader.writeUInt32LE(offset, 42)
    central.push(entryHeader, name)

    offset += header.length + name.length + deflated.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBuffer, end])
}

/** Pack a build directory into `<repo root>/<name>` and report it. */
function writeArchive(sourceDir, outputName) {
  const target = resolve(root, outputName)
  rmSync(target, { force: true })
  const archive = packDirectory(resolve(extensionDir, sourceDir))
  writeFileSync(target, archive)
  return { target, bytes: archive.length, files: collectFiles(resolve(extensionDir, sourceDir)).length }
}

const version = resolveVersion()
const archives = [
  writeArchive('dist', `dsh-browser-crossplatform-${version}.zip`),
  writeArchive('dist-firefox', `dsh-browser-crossplatform-${version}-firefox.zip`),
]
for (const { target, bytes, files } of archives) {
  console.log(`wrote ${target} (${files} files, ${bytes} bytes)`)
}
