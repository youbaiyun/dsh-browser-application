/**
 * Write store archives with spec-compliant entry names.
 *
 * PowerShell's `Compress-Archive` uses the Windows path separator inside the
 * archive, so 11 of the 14 entries in each previous archive were stored as
 * `assets\icons\icon128.png` rather than `assets/icons/icon128.png`. The ZIP
 * specification requires forward slashes, and the consumers that matter enforce
 * it: a store uploader validates entry names, and a browser unpacking the
 * extension looks for `control/index.html` by that exact path. The archive still
 * opened in Explorer, which is why this survived until a byte-level check.
 *
 * This writes the container itself rather than shelling out to a zip tool, so the
 * separators are what this file says they are and there is no dependency on which
 * tool happens to be on PATH. Entries are stored uncompressed: a store archive of
 * 83 KB costs nothing to keep uncompressed, and it removes both the deflate
 * implementation and a class of bug that only shows up on a reviewer's machine.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** Standard CRC-32, which every ZIP entry needs. */
const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Every file under a directory, with POSIX-style relative names. */
const collect = (root, dir = root, into = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { collect(root, full, into); continue }
    // The one place the separator is chosen. Everything downstream is bytes.
    into.push({ full, name: relative(root, full).split(sep).join('/'), mode: statSync(full).mode })
  }
  return into
}

const dosTime = (date) => {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

const zipDirectory = (sourceDir, outPath) => {
  const files = collect(sourceDir).sort((a, b) => (a.name < b.name ? -1 : 1))
  const locals = []
  const centrals = []
  let offset = 0

  for (const file of files) {
    const data = readFileSync(file.full)
    const nameBytes = Buffer.from(file.name, 'utf8')
    const crc = crc32(data)
    const { time, day } = dosTime(statSync(file.full).mtime)

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)          // local file header
    local.writeUInt16LE(20, 4)                  // version needed
    local.writeUInt16LE(0x0800, 6)              // UTF-8 names
    local.writeUInt16LE(0, 8)                   // stored, not deflated
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)        // compressed size
    local.writeUInt32LE(data.length, 22)        // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)                  // no extra field
    nameBytes.copy(local, 30)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)        // central directory header
    central.writeUInt16LE(0x031e, 4)            // made by: Unix, version 30
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)                // extra
    central.writeUInt16LE(0, 32)                // comment
    central.writeUInt16LE(0, 34)                // disk number
    central.writeUInt16LE(0, 36)                // internal attributes
    // External attributes: the Unix mode in the high 16 bits, so a browser that
    // honours permissions does not see a file it cannot read. Forced unsigned:
    // a left shift that sets the top bit becomes negative in JavaScript, and
    // writeUInt32LE rejects a negative value.
    central.writeUInt32LE(((file.mode & 0xffff) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)

    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }

  const centralDir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)              // end of central directory
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)                      // no comment

  writeFileSync(outPath, Buffer.concat([...locals, centralDir, end]))
  return files.map((f) => f.name)
}

export { zipDirectory }

// Called directly: zip the two build outputs into the backup.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [, , extDir, outDir, version] = process.argv
  const targets = [
    { from: join(extDir, 'dist'), to: join(outDir, `C-upload-to-chrome-store-${version}.zip`) },
    { from: join(extDir, 'dist-firefox'), to: join(outDir, `D-upload-to-firefox-store-${version}-firefox.zip`) },
  ]
  for (const { from, to } of targets) {
    const names = zipDirectory(from, to)
    const bad = names.filter((n) => n.includes('\\'))
    console.log(`${to.split(/[/\\]/).pop()}  (${statSync(to).size} bytes)`)
    console.log(`  entries: ${names.length}`)
    console.log(`  names containing a backslash: ${bad.length}`)
    console.log(`  root manifest.json: ${names.includes('manifest.json') ? 'yes' : 'NO'}`)
  }
}
