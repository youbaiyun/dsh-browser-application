/**
 * Rebuild the backup at D:\DSH-demo from the current repository state.
 *
 * Assembling a backup by hand went wrong three times in one afternoon: a Chinese
 * folder name that Windows rejected, four documents left pointing at folders that
 * no longer existed, and a stale version number in the index. Every one of those
 * is a mechanical detail, so this does them in one pass and reports what it did.
 *
 * Run:  node sync-backup.mjs <repo> <backup-root>
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const REPO = process.argv[2]
const BACKUP = process.argv[3]
const GIT = 'C:/Program Files/Git/cmd/git.exe'

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const version = readJson(join(REPO, 'extensions', 'dsh-browser', 'manifest.json')).version
const rootVersion = readJson(join(REPO, 'package.json')).version
console.log(`repository version: extension ${version}, root ${rootVersion}`)
console.log(`backup root: ${BACKUP}\n`)

const say = (s) => console.log('  ' + s)

// 1. Loadable extension, and the Firefox build.
const extDist = join(REPO, 'extensions', 'dsh-browser', 'dist')
const ffDist = join(REPO, 'extensions', 'dsh-browser', 'dist-firefox')
const extTarget = join(BACKUP, '01-browser-extension')

for (const [label, from, to] of [
  ['A-load-unpacked-extension-use-this', extDist, join(extTarget, 'A-load-unpacked-extension-use-this')],
  ['B-firefox-build', ffDist, join(extTarget, 'B-firefox-build')],
]) {
  if (!existsSync(from)) { say(`SKIP ${label}: ${from} does not exist (build first)`); continue }
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true })
  say(`refreshed ${label}`)
}

// 2. Upload archives. The store rejects a nested manifest, so the archive holds
//    the contents of dist, not the dist folder.
const zips = [
  [`C-upload-to-chrome-store-${version}.zip`, extDist],
  [`D-upload-to-firefox-store-${version}-firefox.zip`, ffDist],
]
for (const name of readdirSync(extTarget).filter((n) => n.endsWith('.zip'))) {
  rmSync(join(extTarget, name), { force: true })
}

/**
 * The archives are written by this repository's own zip writer.
 *
 * They used to be made with PowerShell's `Compress-Archive`, which stores the
 * Windows separator inside the archive: 11 of 14 entries were
 * `assets\icons\icon128.png` rather than `assets/icons/icon128.png`. The ZIP
 * specification requires forward slashes and the consumers that matter enforce
 * it — a store uploader validates entry names, and a browser unpacking the
 * extension looks for `control/index.html` by that exact path. The archive still
 * opened in Explorer, so nothing looked wrong until the entry bytes were read.
 *
 * `make-store-zips.mjs` writes the container directly, so the separators are
 * whatever that file says and no external tool can change them. Entries are
 * stored uncompressed, which costs about 160 KB and removes both a dependency and
 * a class of bug that appears only on someone else's machine.
 */
const zipDirectory = (from, to) => {
  const script = join(REPO, 'scripts/make-store-zips.mjs')
  const result = execFileSync(process.execPath, [script, dirname(from), dirname(to), version], {
    encoding: 'utf8',
  })
  // The writer reports its own entry names; a backslash here means the archive
  // must not be uploaded, so it is checked rather than assumed.
  if (/backslash: [1-9]/.test(result)) throw new Error(`archive contains a backslash entry name:\n${result}`)
}

for (const [name, from] of zips) {
  if (!existsSync(from)) { say(`SKIP ${name}: no build output`); continue }
  zipDirectory(from, join(extTarget, name))
  const kb = (statSync(join(extTarget, name)).size / 1024).toFixed(1)
  say(`packed ${name}  (${kb} KB)`)
}

// 3. Source, including git history, excluding node_modules.
//    The destination folder carries the version, so a stale one from a previous
//    release must go — otherwise the backup holds two trees and the index names
//    only one of them.
const srcParent = join(BACKUP, '02-source-code')
const sourceCopyName = `dsh-browser-application-${version}-full-source`
for (const entry of readdirSync(srcParent)) {
  // Anything that is not the copy this run is about to make. Keying off the
  // current name alone left a copy from before the project was renamed sitting
  // beside the new one, so the backup held two trees and the index named one.
  if (entry !== sourceCopyName) {
    rmSync(join(srcParent, entry), { recursive: true, force: true })
    say(`removed previous source copy: ${entry}`)
  }
}
const srcTarget = join(srcParent, sourceCopyName)
mkdirSync(srcTarget, { recursive: true })

/**
 * Remove excluded directories from a copy that already has them.
 *
 * Robocopy's exclusions stop files being copied; they do not remove files that an
 * earlier run already put there. So adding `coverage` to the exclusion list left
 * the existing 18-file coverage report in the backup — the rule was in place and
 * the thing it was meant to prevent was still on disk. Cleaning before copying
 * makes the exclusion true rather than aspirational.
 */
const pruneExcluded = (root) => {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (EXCLUDED_DIRS.includes(entry.name)) {
        rmSync(full, { recursive: true, force: true })
        continue
      }
      stack.push(full)
    }
  }
}

/**
 * Copy with robocopy, treating its exit codes as the success report they are.
 *
 * robocopy returns 1 for "files were copied" and up to 7 for other benign
 * outcomes; only 8 and above mean failure. Node turns any non-zero status into a
 * thrown error, so a successful copy looks like a crash unless it is caught.
 */
const robocopy = (from, to) => {
  try {
    execFileSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' })
  } catch (error) {
    if (typeof error?.status === 'number' && error.status < 8) return
    throw error
  }
}

/**
 * Directories robocopy must not carry into the backup.
 *
 * `node_modules` is restored by `pnpm install` if ever needed. `coverage` is a
 * test artifact that git ignores, so copying it put a directory in the backup
 * that no commit contains and no reader was meant to see. `.idea` is an editor's
 * own state.
 *
 * `dist` and `dist-firefox` are deliberately *not* listed, and the reason is the
 * opposite of what an earlier version of this comment claimed. They are gitignored
 * build outputs — nothing commits them — but the backup keeps them on purpose:
 * the loadable extension in `01-browser-extension` and both store archives are
 * copied from `dist`, so a backup without it could not be installed from. The
 * source copy is what the commit defines; the backup is what a person can use.
 */
const EXCLUDED_DIRS = ['node_modules', 'coverage', '.idea', '.vitest']

// node_modules is excluded here and restored by `pnpm install` if ever needed.
try {
  execFileSync('robocopy', [REPO, srcTarget, '/E', '/XD', ...EXCLUDED_DIRS, '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' })
} catch (error) {
  if (!(typeof error?.status === 'number' && error.status < 8)) throw error
}
robocopy(join(REPO, '.git'), join(srcTarget, '.git'))
pruneExcluded(srcTarget)
const head = execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: srcTarget, encoding: 'utf8' }).trim()
say(`copied source  (HEAD ${head.slice(0, 8)})  ->  ${srcTarget.slice(BACKUP.length + 1)}`)

// 4. Documents that live outside the repository checkout.
//
//    These folders are emptied first rather than merely overwritten. Copying
//    into them leaves the previous file behind whenever a document is renamed,
//    and that happened twice during the project rename: the backup ended up
//    holding both the old and the new skill file, so a reader could not tell
//    which one was current. Only 01's archives and 02's source tree are allowed
//    to manage themselves; everything here is a mirror and is rebuilt as one.
const docs = [
  ['03-store-listing/listing-copy-name-summary-description.md', 'store-assets/store-listing.md'],
  ['03-store-listing/permission-and-data-disclosure.md', 'store-assets/permission-justification.md'],
  ['03-store-listing/publishing-steps-and-pitfalls.md', 'store-assets/PUBLISHING.md'],
  ['03-store-listing/submission-form-field-by-field.md', 'store-assets/submission-checklist.md'],
  ['03-store-listing/privacy-policy-must-be-public.md', 'PRIVACY.md'],
  ['04-skill/dsh-browser-Application-troubleshooting-SKILL.md', 'skills/dsh-browser-Application-troubleshooting/SKILL.md'],
  ['05-license-and-docs/INSTALL-guide-read-this-first.md', 'INSTALL.md'],
  ['05-license-and-docs/README-en.md', 'README.md'],
  ['05-license-and-docs/README-zh.md', 'README.zh.md'],
  ['05-license-and-docs/LICENSE-MIT.txt', 'LICENSE'],
  ['05-license-and-docs/COPYRIGHT-who-owns-what.md', 'COPYRIGHT.md'],
  ['05-license-and-docs/CHANGELOG.md', 'CHANGELOG.md'],
  ['05-license-and-docs/CONTRIBUTING.md', 'CONTRIBUTING.md'],
  ['05-license-and-docs/SECURITY.md', 'SECURITY.md'],
  ['05-license-and-docs/CODE_OF_CONDUCT.md', 'CODE_OF_CONDUCT.md'],
  ['07-trust-model/TRUST-MODEL-what-it-can-reach.md', 'docs/TRUST-MODEL.md'],
]

/** Rebuild one mirrored folder from empty, so a rename cannot leave an orphan. */
const mirrorFolder = (name, entries) => {
  const dir = join(BACKUP, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const [to, from] of entries) {
    cpSync(join(REPO, from), join(BACKUP, to))
  }
  say(`rebuilt ${name}  (${entries.length} file${entries.length === 1 ? '' : 's'})`)
}

const byFolder = new Map()
for (const entry of docs) {
  const folder = entry[0].split('/')[0]
  if (!byFolder.has(folder)) byFolder.set(folder, [])
  byFolder.get(folder).push(entry)
}
for (const [folder, entries] of byFolder) mirrorFolder(folder, entries)

// 5. The index: version and date must match what was just copied, or the backup
//    lies about which release it holds. The date is taken in local time — an ISO
//    string is UTC, which lands on the previous day for anyone east of Greenwich
//    and makes a fresh backup look stale.
// 5. The index.
//
//    It used to live only in the backup and be patched in place by regex, which
//    is why it drifted: each of this project's renames left a few lines behind,
//    and by the time anyone looked, it named a source directory, a skill folder,
//    two archive names and a release that no longer existed. A document that
//    cannot be reviewed cannot be kept correct.
//
//    It is now a file in the repository, copied fresh on every sync, with only
//    the three values a generator knows — version, timestamp, repository URL —
//    substituted. Everything else is edited where it is reviewed.
const indexPath = join(BACKUP, '00-READ-ME-FIRST.md')
let index = readFileSync(join(REPO, 'docs/backup-index.md'), 'utf8')
const now = new Date()
const stamp = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
].join('-')
const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
index = index.replace(/版本：\*\*[^*]+\*\*/, `版本：**${version}**`)
index = index.replace(/备份时间：[^\n]+/, `备份时间：${stamp} ${clock}（自动同步）`)
index = index.replace(
  /原仓库：[^\n]+/,
  `原仓库：https://github.com/youbaiyun/dsh-browser-application`,
)

// A substitution that silently does not match would leave the template's
// placeholder in a document a person reads, so each one is confirmed.
const substituted = [
  [`版本：**${version}**`, 'version'],
  [`备份时间：${stamp} ${clock}`, 'timestamp'],
  ['https://github.com/youbaiyun/dsh-browser-application', 'repository URL'],
]
for (const [needle, label] of substituted) {
  if (!index.includes(needle)) throw new Error(`backup index: ${label} was not substituted`)
}
writeFileSync(indexPath, index)
say(`index rebuilt from docs/backup-index.md for version ${version}, ${stamp} ${clock}`)

// 6. Verify rather than assume.
console.log('\nverification:')
const problems = []
for (const [name, dir] of zips) {
  const p = join(extTarget, name)
  if (!existsSync(p)) { problems.push(`missing archive ${name}`); continue }
  const bytes = readFileSync(p)
  const entries = []
  let withBackslash = 0
  for (let i = 0; i < bytes.length - 4; i += 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02) {
      const length = bytes.readUInt16LE(i + 28)
      const nameBytes = bytes.subarray(i + 46, i + 46 + length)
      // The separator is checked as a byte, not as a character: 0x5C is what a
      // Windows tool writes and what a store uploader rejects, and it is
      // invisible in any listing of the archive.
      if (nameBytes.includes(0x5c)) withBackslash += 1
      entries.push(nameBytes.toString('utf8'))
    }
  }
  const ok = entries.includes('manifest.json')
  const separatorsOk = withBackslash === 0
  say(`${name}: ${entries.length} entries, manifest at root: ${ok ? 'yes' : 'NO'}, backslash paths: ${separatorsOk ? 'none' : `${withBackslash} <-- WILL BE REJECTED`}`)
  if (!separatorsOk) problems.push(`${name} uses the Windows separator in ${withBackslash} entry names`)
  if (!ok) problems.push(`${name} has no root manifest`)
}
const extVersion = readJson(join(extTarget, 'A-load-unpacked-extension-use-this', 'manifest.json')).version
say(`loadable extension manifest version: ${extVersion}${extVersion === version ? '' : '  <-- MISMATCH'}`)
if (extVersion !== version) problems.push('loadable extension is a different version from the repository')
say(`source HEAD matches repository: ${head === execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() ? 'yes' : 'NO'}`)

console.log('')
console.log(problems.length === 0 ? 'backup is consistent' : `problems:\n  ${problems.join('\n  ')}`)
process.exit(problems.length === 0 ? 0 : 1)
