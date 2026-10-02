# Changelog

This project is a derivative of
[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser). Upstream releases
are listed only where this fork has something to say about them; see
[COPYRIGHT.md](COPYRIGHT.md) for which files belong to whom.

## [0.3.1]

### Added

- **The browser group is named.** Conversations from the side panel are grouped
  into a workspace, and the desktop names a new workspace after its directory —
  so the group appeared as `browser-sessions`, which reads like an internal
  detail. Nothing in the interface renames a workspace, and nothing announces
  that the group exists, so the reasonable conclusion was that the conversations
  were never saved. The bridge now gives it a display name
  (`sessionWorkspaceTitle`, defaulting to 浏览器对话). A name already in use is
  reported and ignored: the grouping still works, and the label is only a label.

### Fixed

- **A conversation survives the service worker being recycled.** The bound
  session lived only in the background worker's memory. Chrome stops an idle MV3
  worker — which happens as soon as the side panel closes — so the next message
  opened a different conversation, and a user's browser history fragmented into
  one session per idle timeout, each of which they had to find on their own. The
  id is now remembered in `storage.local` and reused, after being checked against
  the desktop's own list so that a session deleted there cannot swallow a prompt.

### Changed

- The project is named consistently. The repository and root package were
  `dsh-browser-lite`, which described a relationship to something else rather
  than what this is, and the troubleshooting skill still carried upstream's
  `dsh-browser-control`. Repository and package are now `dsh-browser-application`;
  the skill is `dsh-browser-Application-troubleshooting` and its directory matches.
  The intermediate name `dsh-browser-hand-eye` and the display name
  「dsh 浏览器的手与眼」 were used during development and appear nowhere in the
  released tree.
- The display name says what the thing is. It was 「dsh 浏览器的手与眼」, a
  metaphor that had to be explained; it is now 「dsh 浏览器扩展（应用端）」. Note
  「扩展」, the term the browsers themselves use — 「拓展」 means to expand a
  business, not to install an add-on.

  **Known risk, recorded rather than hidden:** the skill name contains an
  uppercase `Application`. The skill is also a directory, and Windows and macOS
  treat file names case-insensitively while Linux does not, so a mixed-case
  directory is a portability question. It is valid — skill names allow letters and
  hyphens — and it installs correctly on all three, but a lowercase
  `dsh-browser-application-troubleshooting` would remove the question entirely.
  This is the one place a casing difference could matter, and it is deliberate.
- Choosing "start a new conversation" now means it: the remembered id is cleared
  first, so the next message cannot restore the conversation the user just left.
- A version literal was removed from a test that asserted one exact release. It
  asserted agreement between three manifests, which is the real invariant; pinning
  the number as well meant editing a test on every release.

### Removed

- **Dead CSS in the panel.** Six rules matched nothing — `btn--danger`,
  `btn__icon`, `notice__icon`, `setting__field` (with its `:focus` and
  `::placeholder`), `sr-only` and `msg--error` — and three custom properties were
  declared and never referenced (`--danger-soft`, `--space-5`, `--space-6`).
  Every one was confirmed absent by exact search, including as a value built from
  a template, and none is referenced by a test. The stylesheet is 31 lines
  shorter. `--space-1` through `--space-4` remain because something uses them.
- An unused `brand` string in the panel's copy table, written for a heading that
  was never built. The panel's heading comes from the browser, which renders it
  from the extension's manifest name; the copy table only ever set the tab title.
  Its presence suggested the header was ours to change, which it is not.

### Fixed — attribution

Reviewing what a reader would see before publishing turned up three places where
this fork appeared to claim work that is not its own. None of them were licence
problems; all of them were the kind of inconsistency a visitor notices first.

- **The bridge plugin listed this fork as its `author`.** The package is
  upstream's — `COPYRIGHT.md` says so — and its name still carries upstream's
  scope. Attributing it here while naming it after someone else is the exact
  contradiction a reader checks for. The field is gone; `contributors` now records
  its origin.
- **The performance table named a backend that does not exist in this
  repository, with no note that the numbers are upstream's.** They were measured
  by upstream, on the engine, which is reuse — the same code, so the figures hold,
  but they were being presented as this build's results. Both READMEs now say
  whose measurement it is and why it still applies.
- **The Chinese README still called the project `dsh 浏览器操作`,** a name from
  two renames ago. It is the only place left describing the project by a name
  that was never shipped.

The upstream architecture notes under `.agents/notes/` are kept, and a README was
added to that folder: they explain why the bridge is built this way, and deleting
them would remove the reasoning and leave only the result. They describe
upstream's arrangement, so the file says which details a fork changes — the
managed install directory and the repository name among them.

### Fixed — comments that no longer described the code

Reviewing the comments turned up six places where the documentation contradicted
the code beside it. Comments are read as authoritative, so each of these was
actively misleading; five of the six were introduced by this release's own
changes, which is the usual way it happens.

- **An approval notification was titled with a name from two renames ago**
  (`dsh 浏览器操作等待确认`). It is user-facing text, so the stale name was visible
  to anyone who received an approval while the panel was closed — and an earlier
  sweep missed it because it searched for "浏览器控制", not "浏览器操作".
- **`sessionScope`'s documentation still described the old `fresh` behaviour** —
  "the panel's own session so browser chatter never lands in a longer
  conversation" — which is precisely what this release changed. Rewritten to state
  that the session is remembered and resumed.
- **The panel's copy table claimed the tab title was the short form while the
  store name carried a parenthetical.** Both are now the full name, so the
  explanation was wrong in the direction a reader would least expect.
- **`index.html` quoted the content security policy without its `connect-src`
  clause.** The quoted policy read as "this page cannot reach the network"; the
  real one permits loopback, which is how the panel talks to the desktop.
- **`session-workspace.ts`'s module header said the wrapper only rewrites
  `session.create`.** It also issues `workspace.create` and `workspace.rename` on
  its own behalf, a distinction that matters to anyone tracing an RPC.
- **A doc block had been orphaned from its subject.** Inserting a new constant
  between a variable and its lengthy documentation left the variable with two
  descriptions and the constant with one that described neither.

### Fixed — the panel answered English users in Chinese

Nine `@open` error messages were hard-coded in the input parser, which consults no
locale, so every mistyped directive reported itself in Chinese whatever language
the panel was in. The panel ships three locales and routes the rest of its copy
through a table; this was the one place a user could not read.

The parser now reports **why** a directive failed — a code and its parts — and the
panel words it. That keeps the parser a pure function of its input, which is what
makes it testable without a DOM, and it fixes two consequences of the old shape
that were not only about language:

- **A malformed directive is no longer a prompt.** It used to be returned as
  `{ kind: 'prompt', text: <the complaint> }`, so submitting a typo would have
  transmitted the complaint to the model as though the user had typed it as an
  instruction — and the user would be waiting for a reply about it. It is now its
  own intent kind, which the panel reports locally.
- **The hint-versus-error distinction no longer depends on the wording.** The
  panel chose between a quiet hint and an alarm by testing whether the message
  began with a particular Chinese phrase. That is text as control flow: in English
  the hint would have disappeared, and a half-typed `@op` would have been shown as
  a mistake. The parser now marks a still-being-typed directive, and the panel
  reads the mark.

Two tests assert the contract that keeps this from regressing: every failure
reason is worded in both languages and differently in each, and the English copy
table contains no Chinese characters anywhere.

### Security review before publishing

A full pass over everything that ships or runs, looking for code that is
malicious, code that reaches further than it declares, and code that could be
turned into either. What was found, and what was not:

**Not found, and verified rather than assumed.** No `eval`, no `new Function`, no
string passed to a timer, no remote script, no `document.write`. Exactly three
outbound network calls exist in the extension, all to loopback; there is no
analytics, telemetry, crash reporting or update check. No file is ever uploaded —
no `input[type=file]` handling, no `FileReader`, no `DataTransfer`, zero matches.
The only two `innerHTML` sinks are a static table of SVG paths selected by a typed
union and Markdown that passes DOMPurify with a narrow allowlist, behind a
`script-src 'self'` policy. Internal messages are checked against
`sender.id !== chrome.runtime.id`.

**Found and fixed.**

- **`activeTab` was declared and never used.** Host access already comes from
  `http://*/*` and `https://*/*`, so the permission granted nothing and was one
  more line for a reviewer to question. Removed from both manifests. The test that
  requires the Firefox permission list to equal the Chrome one minus `sidePanel`
  still passes, which is the check that would have caught a mistake here.
- **The backup script built a PowerShell command by interpolation.** Paths were
  substituted into the command text inside single quotes, so a path containing a
  quote would have ended the string and the remainder would have been parsed as
  PowerShell. The paths now travel in the environment, where a value cannot become
  code. `scripts/sync-backup.mjs` is a developer tool rather than shipped code,
  which makes the flaw small — but it is the same shape as the one this document
  exists to rule out, and it was written during this project.
- **A path from the author's own disk was in a published document.** The
  troubleshooting skill named a directory on one machine; a documentation file
  carried a full Windows profile path. Both are replaced with the portable form,
  because a private path is meaningless to a reader and reveals the shape of a
  machine that is not theirs.

**Documented rather than changed.** Two capabilities are intended design and are
now written down where a user will see them, in
[docs/TRUST-MODEL.md](docs/TRUST-MODEL.md):

- **`bridgeUrl` is a stored setting the panel does not expose.** Left empty,
  discovery finds the local bridge. Set — which requires editing extension storage
  directly — it could name a remote host, and page text would go there. This is
  inherited from upstream and is the largest non-obvious thing the extension can
  be made to do.
- **Host access is all http/https sites**, because the extension cannot know which
  tab it will be pointed at. Injection is broad; authority is not: one bound tab,
  chosen by the user, behind per-site trust and approval.

`SECURITY.md` gained both, since a security policy that lists only strengths is
not one.

### Fixed — the backup index had drifted, and could not have not drifted

The document a person follows to find things in `D:\DSH-demo` lived only in the
backup, and `sync-backup.mjs` maintained it by regex replacement. It had
accumulated a source directory name, a skill folder, two archive names and a
release number that no longer existed — because a file outside version control
cannot be reviewed, and each of this project's renames left a few lines behind.

It is now `docs/backup-index.md` in the repository, copied fresh on every sync,
with only the version, timestamp and repository URL substituted — each
substitution confirmed, so a template placeholder cannot survive into the
document. The index also gained a section for the trust model, bringing the backup
to seven folders.

### Fixed — the Traditional Chinese locale was left behind

The rename updated `_locales/zh_CN` and `_locales/en` and missed
`_locales/zh_TW`, so Traditional Chinese users would have seen the previous name
on the extensions page, in the toolbar tooltip and in the store listing. It now
reads 「dsh 瀏覽器擴充功能（應用端）」 — note 擴充功能, which is what the browsers
themselves call an extension in Traditional Chinese, rather than 手與眼.

Nothing caught it because no test read `_locales` at all: the manifest names a
locale directory and the browser loads whatever is there, so a locale file is the
one part of the extension with no test coverage and no compile-time check. Five
tests now cover the whole directory — every locale defines the keys the manifest
and toolbar need, no message is blank, no locale states a retired name, the three
agree on the product token, and the Chinese locales use the localised word for
"extension". The retired-name test was confirmed to fail when the old name is put
back, so it is a check rather than a decoration.

### Fixed — test artifacts were copied into the backup

`packages/browser/bridge-browser/coverage/` is a coverage report that git ignores,
but the backup copied the working tree rather than the commit, so the folder
appeared in `02-source-code` with no commit behind it — 20 files of HTML for a
reader to wonder about. `node_modules`, `coverage`, `.idea` and `.vitest` are now
excluded from the copy. The build outputs are deliberately not excluded: `dist/`
and `dist-firefox/` are committed, because the loadable extension and the two
store archives are built from them.

### Fixed — the store archives used Windows path separators inside the ZIP

Both archives were built with PowerShell's `Compress-Archive`, which on Windows
stores the entry names as `assets\icons\icon128.png` rather than
`assets/icons/icon128.png`. The ZIP specification requires forward slashes, and
the consumers that matter enforce it: a store uploader validates entry names, and
a browser unpacking the extension looks up `control/index.html` by exactly that
path. **11 of the 14 entries in each archive were affected** — the icons, the
panel, the panel's script and the locale files.

It survived every check that existed because the archive is not obviously broken:
it opens in Explorer, `manifest.json` is at the root where it belongs, and Windows
reads its own archives either way. It was found by reading the separator byte,
`0x5C`, rather than the decoded character — the character looks plausible and the
byte is the defect.

`scripts/make-store-zips.mjs` now writes the container itself, so the separators
are whatever that file says they are and no external tool can change them. Entries
are stored uncompressed, which costs about 160 KB per archive and removes both a
dependency and a class of bug that would only appear on someone else's machine.
`sync-backup.mjs` verifies the separator byte in both archives as part of its own
verification step, so this cannot come back unnoticed.

## [0.3.0] — first public release

The starting point is upstream `0.1.4`. Everything below is the difference.

### Replaced

- **The panel.** Upstream's React application (22 files, 8 520 lines) is gone,
  replaced by a plain-TypeScript side panel (7 files, 2 827 lines). The panel is
  a conversation: your message, the reply, and one quiet line per tool run.
- Removed with it: text-selection quoting, question cards, update cards, UI
  scale, and image attachments. Each was a deliberate subtraction, not an
  omission — the goal is a control strip, not a dashboard.

### Added

- **A panel origin marker.** Every prompt typed in the panel carries a fixed
  prefix, so the model can tell a real instruction from a sentence a web page
  planted. It is applied on the single code path that submits a prompt, which
  makes impersonation an architectural property rather than a request the model
  is asked to honour.
- **`openPagesForUser`, an app-side switch.** Whether the model may open and
  navigate pages is decided by the desktop app and sent to the extension in the
  handshake. Turning it off swaps the prompt rule for a denying one, makes
  `@open` refuse, and suppresses automatic panel opening. A missing policy reads
  as "not allowed", so a dropped field cannot hand out a permission nobody gave.
- **`@open`, a deterministic command.** `@open <url>` in the panel opens the
  page, brings it forward, and binds it without involving the model.
- **Address recovery.** The desktop app picks its port at startup, so a restart
  can land elsewhere. After three failed probes the extension re-runs discovery
  instead of dialling a dead port indefinitely.
- **A replaced-connection notice.** When another browser takes the single bridge
  slot, the panel says so and offers to take the connection back.
- **`skills/dsh-browser-Application-troubleshooting/`.** A troubleshooting skill the model reads when
  something breaks. The installers copy it into the DSH home.
- **A build-freshness check** (`pnpm run check:build`), because the desktop app
  loads the plugin's built `lib/`, and editing `src/` without rebuilding changes
  nothing that runs.

### Fixed

- The panel's mount element had no height, so every percentage below it stopped
  resolving. The settings sheet rendered in a short box with dead space beneath
  it. The stylesheet named `#root`; the page used `#control-root`.
- The composer's textarea carried padding that `autoGrow` counted twice, so a
  one-line draft rendered 1.8 lines tall with a scrollbar, and the send button
  drifted away from the last line as text was added.
- The input's height was a fraction of the window, so the same draft occupied a
  different share of the screen depending on the monitor. It is now a fixed cap.
- `@open` accepted `verify=` and silently ignored it. A parameter that appears to
  work but does nothing is worse than one that is refused, so it is refused now.
- `systemBrowserCandidates` returned an empty list on Windows, so no system
  Chrome was ever discovered there.

### Verification

- 327 extension tests, 150 bridge-plugin tests (two are Windows-only platform
  limitations), and 24 benchmark tests.
- A real-browser layout measurement (`pnpm --filter dsh-browser-extension run
  test:layout`) checks eleven viewport sizes plus the composer's growth, because
  jsdom has no layout engine and cannot answer geometry questions.

### Known issues

- `pnpm run test:smoke` fails at the session-disposal assertion on DSH
  0.2.0-rc.2. It fails the same way on a clean checkout of this fork and in the
  upstream tree, and it is unrelated to the panel work. CI therefore reports red.
- Two bridge-plugin tests cannot pass on Windows: the platform cannot report
  POSIX `0600`, and creating a directory symlink needs elevation.
