# Changelog

This project is a derivative of
[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser). Upstream releases
are listed only where this fork has something to say about them; see
[COPYRIGHT.md](COPYRIGHT.md) for which files belong to whom.

## [0.38.2]

No code changed. Only the version number, for a reason worth writing down: **npm
retires version numbers two different ways, and this package has now hit both.**

- `0.38.0` was published on 2026-10-06 and unpublished 23 minutes later. npm
  permanently retires a version that has been unpublished, so it can never be
  published again.
- `0.38.1` was accepted by `pnpm publish`, which stages a package and waits to be
  told to promote it. The promotion never happened, and the registry now refuses
  that version with `409 Cannot publish over previously staged version "0.38.1"` —
  a marker that survives the staged record being emptied (`pnpm stage list` reports
  nothing).

`0.38.2` is the first version number on this package name with no history behind
it. Until now the registry has also been carrying a `0.0.0-stage` placeholder as
`latest`, which is what a client would have downloaded; a normal publish replaces
it as `latest`.

Publish with `npm publish`, not `pnpm publish`: npm writes the version directly
and does not stage it, so there is nothing left to promote.

## [0.38.1]

A naming and wording release. No behaviour changed.

### Changed

- **The extension is called `dsh 浏览器扩展（全端）`** (`dsh 瀏覽器擴充功能（全端）`
  in Traditional Chinese). The parenthetical said `应用端` — the *application* side —
  which described only one end of a product that has several. The English name,
  `dsh Browser Extension`, already carried no such limit and is unchanged.
- **The short description now says which model reads a picture.** The Chinese version
  ended at "会把你要看的那张图交给桌面端", which reads as though the desktop app looks
  at the image itself; the picture is handed to the model configured there, so it now
  says so. The English version was reworded to match (`Image look-up is optional` →
  `Image look-up optional`) and is **122 characters** against the store's 132 limit —
  short enough that naming the model there as well would have pushed it over, which is
  why the detailed description carries that detail instead. The store listing, the
  paste-in sheet and the submission form were kept byte-equal to `_locales/en`, which
  `extension/tests/locales.spec.ts` asserts.
- **`0.38.0` was never published to npm and cannot be**: the name
  `dsh-browser-crossplatform` was registered on 2026-10-06 and unpublished 23 minutes
  later, and npm permanently retires a version number that has been unpublished. This
  release therefore takes `0.38.1`, and every version-holding file moved with it.

## [0.38]

A correctness and truthfulness pass over 0.37: one security boundary narrowed,
a browser that is closed can now be started by the desktop, several claims in the
documentation brought back in line with the code, and the release tooling made to
produce what the stores actually accept.

### Added

- **A task list the user can watch.** A request that needs several browser steps was
  previously visible only as a stream of tool calls: the reader could see each step
  but not the job they belonged to, and a finished step looked exactly like a
  pending one — the same request apparently repeating. Now the model opens such a
  turn by writing the checklist it is about to execute and re-emits it with the
  boxes ticked as it goes, and the panel renders that checklist above the run with
  the task in progress, the finished ones and the failed ones marked.
  - The format is a plain markdown checkbox list (`- [ ]`, `- [>]`, `- [x]`, `- [!]`),
    declared to the model in the bridge's system-prompt section and parsed by
    `packages/protocol/src/plan.ts`, so the wording the model is given and the shape
    the panel reads cannot drift.
  - The rule lives inside the prompt's existing ASCII-only section, so the
    homoglyph assertion in `packages/bridge/tests/index.spec.ts` covers it too.
  - A streaming update never shrinks the list: the model rewrites the checklist
    while it is still arriving, so the panel keeps the more complete of the two
    versions (`preferPlan`) instead of truncating the list on every tick.
  - A plan written without boxes is still recognised, but only under a heading that
    announces one, so an ordinary bulleted answer is not mistaken for a task list.
- **The activity line now carries the outcome, not just the attempt.** Every
  successful row used to read `browser_navigate https://www.bilibili.com` — what was
  asked for, with nothing about whether it happened, so a completed step was
  indistinguishable from one that never ran. Rows now end with the tool's own
  one-line answer (`✓ Opened a new tab at …`), `browser_list_tabs` reports how many
  tabs it listed, and the URL in the request part is still reduced to its origin so
  paths and query terms do not accumulate in the list.
- **`browser_launch`, and a preflight on every browser tool.** Tool execution lives
  in the extension, so a closed browser left the model with a bare `bridge-closed`
  error and no way out. A call with no connection now tries to start the browser
  first and reports what actually happened.
  - It launches **the browser the user already uses** — the executable comes from
    the system's default-browser record — with **no extra flags at all**: no
    `--user-data-dir` (that would be a second browser, with none of the user's tabs
    or logins) and no `--load-extension`.
  - If that browser is **already running, nothing is launched**: a second start only
    hands the request to the existing process and discards the flags, so the answer
    names the browser to enable the extension in rather than opening a dead window.
  - It also checks whether the extension is installed in any Chrome/Edge/Brave/
    Chromium profile and says which situation applies, because a launch cannot
    install anything: an unpacked `--load-extension` lasts one session and is gone
    at the next start (verified), and since Chrome 137 branded Chrome/Edge builds
    ignore the flag entirely (Chromium and Chrome-for-Testing still honour it).
  - Gated by `openPagesForUser`, the switch that already decides whether the model
    may drive the browser to new places. `browserUserDataDir`, `extensionPath` and
    `browserHeadless` cover the development case, a named profile that genuinely
    loads an unpacked build.
  - **The dead end is closed explicitly.** Being told "install the extension" with
    no destination is what left users stuck, so the answer now carries the browser's
    own extensions page (`chrome://extensions/` or `edge://extensions/`) and the
    bridge **opens that page** at the moment it has established the extension is
    installed nowhere — the only situation with no automatic way out. Opening it
    goes through the OS handler (`cmd start` / `open` / `xdg-open`), so it lands in
    whichever browser the user actually uses, Firefox included. `docs/INSTALL.md`
    and its Chinese twin now lead with "install the extension first, in the browser
    you actually use" and gained a "the browser was closed and the model could not
    open it" entry; the troubleshooting skill gained the same two checks.

### Security

- **The token-free loopback path is now bound to one named extension.** It used to
  accept any upgrade whose `Origin` merely started with `chrome-extension://` —
  and every other extension installed in the same browser presents one of those,
  so any of them (or a local process that simply sets the header) could reach the
  full browser tool surface without the token. The check is now an exact match
  against the configured `extensionId`, whose default is the id this repository's
  manifest `key` derives (`kdhkdgfcinfkmogifamoapmheihhcjfk`). Set
  `extensionId: ''` to require the token on every connection, loopback included.
  `docs/TRUST-MODEL.md` states the residual exposure plainly: a process that knows
  the id can still forge the header.

### Fixed

- **Copy that contradicted the code, found in a pre-release pass over every
  user-facing string.** Each of these made the product describe something other
  than what it does:
  - The store listing claimed "no dashboards, no progress bars" while the panel now
    renders the per-turn task list with a `{done}/{total}` counter. Both languages
    were corrected in `store-assets/store-listing.md` and its paste-in twin.
  - `plan.progress` counted **failed** tasks as completed (`{done}` received
    `done + failed`), so a 3-pass/2-fail checklist read "5/5 已完成" beside two rows
    marked `✕`. Only finished tasks count now.
  - The settings row read "AI 能打开网页" / "AI can open web pages" next to a badge
    that reports the *handshake*, which could read as "this feature is off" — in a
    store review, as a permission the extension does not have. The label now names
    the desktop as the side that decides.
  - `visionTierHelp` (EN) promised "every image looked at is one request", which the
    24-hour description memo and per-identity de-duplication contradict; both
    languages now state the cost, what leaves the machine, and that a repeat
    question is answered from the memo.
  - Five copy keys that nothing rendered were removed from both languages
    (`common.working`, `composer.commandBadge`, `composer.askBadge`,
    `composer.unavailable`, `approval.origins`).
  - `store-assets/permission-and-data-disclosure.md` now says what the relay sends
    when the extension's own image fetch fails: the image's address, not its bytes.

- **The end-to-end suite was passing without running.** It drove the system
  Chrome, which since 137 ignores `--load-extension`, and a missing browser made
  the suite *skip* — a green that proved nothing. CI now installs Playwright's own
  Chromium (via `benchmark/lib/browser-install.mjs`, which resolves the CLI
  through Node instead of a shell) and the resolver
  `benchmark/lib/chromium-path.mjs` asks `playwright-core` which revision to load,
  so the path cannot drift. The e2e also binds whichever discovery port is free
  rather than 3080 specifically, because a leftover socket used to surface as a
  60-second "no connection" failure that said nothing about the cause.
- **`Compress-Archive` was wrong for a store upload.** It writes `\` entry names,
  which the stores reject, and the publishing notes only warned about Windows
  "send to → compressed folder". Both archives are now produced by
  `extension/scripts/package.mjs`: a dependency-free ZIP writer that always emits
  `/`, refuses a backslash entry, and names each archive after the version in the
  manifest inside it.
- **`extension/scripts/build.mjs` no longer passes `shell: true` with an argument
  list** (Node 24 deprecates it, DEP0190); the Windows `.cmd` shim is named
  explicitly instead, so watch and build behave the same on every platform.
- **`README.md` and its Chinese twin described a design the code does not have.**
  The manifests still declare global `content_scripts` (the README claimed they
  were removed), the tool surface is 17 including `browser_launch` and
  `browser_describe_image` (said 15), the image section shares the interactive item
  budget rather than splitting the character budget, the vision default is
  `deepseek-flash` (one example showed `deepseek-v4.1-flash`, the display name the
  code says returns 400), and a dozen file paths pointed at modules that do not
  exist in this tree.
- **Two capabilities the tool schema promised were implemented rather than
  retracted.** `browser_type` advertised filling a `<select>` and setting a
  checkbox/radio, and `browser_wait` advertised `selector`/`text` conditions that
  fail with `timeout` — the executor did neither: a `<select>` was rejected as "not
  editable", a checkbox was written through the text `.value` path, and a wait
  condition was silently ignored so the model got a success for something that
  never happened. Both now work (`content/actions.ts`) and are pinned by
  `extension/tests/actions-form-controls.spec.ts`. A schema that promises behaviour
  is a bug report against the executor.
- **The temporary connection trace was removed** (`dshBridgeTraceProbe`). It was
  marked "Remove before publishing" and still wrote a rolling 120-line log into
  `chrome.storage.local` on every discovery attempt.
- **Launch resolves the extension directory only if it holds a `manifest.json`.**
  An unrelated `extension/dist` above an installed package would have been passed
  to `--load-extension`, and Chrome refuses to start over a bad path.
- **Two prompt constants are now asserted instead of described.** The system-prompt
  halves are exported (`BROWSER_PROMPT_PREAMBLE` / `BROWSER_PROMPT_MARKER_RULE`)
  and `packages/bridge/tests/index.spec.ts` fails if either grows a non-ASCII
  character or starts quoting the panel marker itself — the anti-impersonation
  invariant that previously rested on a comment.
- **`extension/package.json` declared Node `^22.19 || >=24`** while the root, the
  bridge and the README said `>=20`; they agree now (the protocol package declares
  no `engines`, being a private workspace package with no scripts to run).

### Changed

- **Version 0.38.0 across the tree**, asserted by `extension/tests/versions.spec.ts`
  so the four copies cannot drift again.
- **The workspace gained `benchmark/` as a member**, so its one devDependency
  (`playwright-core`, used to run the baseline browser and now the e2e's Chromium)
  installs with the same `pnpm install` as everything else. `check.yml` also runs
  the benchmark's own unit tests and the packaging step, and no longer points the
  e2e at `/usr/bin/google-chrome`.
- **`config/` is now a sanitized template.** The three desktop-config backups had
  this machine's absolute paths and its real workspace/session ids in them; they
  are placeholders now, with the convention documented in
  `config/README-what-these-are-and-how-to-restore.md`.
- **The packaged signing key and both committed archives were removed**
  (`extension/dist.pem`, `extension/dist.crx`, and the two 0.37.1 zips, which no
  longer matched the tree). Archives are built on demand, not shipped in the
  source.
- **The bundled troubleshooting skill was repaired**: its `name` now matches its
  directory, and its paths point at `packages/bridge` rather than the pre-0.37
  layout.
- **`browser_launch` validated the page it was told to open.** The value becomes an
  argument in the browser's argv, so `--headless` or `--load-extension=…` was read by
  the browser as a switch rather than as a page. Only an absolute `http:`/`https:`
  address is passed through now (`isWebUrl`/`webUrlOrUndefined`), on both the launch
  and the argument-building side, and a padded address is trimmed.
- **Turning unrestricted browser control off could fail to persist.** The revocation
  barrier awaits each in-flight call's `settled` promise, but `cancelAllToolCalls`
  emptied the map without resolving them, so a disconnect inside the window left the
  barrier waiting forever and the restrictive setting was never written — the safety
  switch silently not applying. Cancellation now settles every call, and the
  in-memory flag is cleared *before* the barrier so a call arriving during it cannot
  still capture the grant.
- **A superseded `session.create` could resurrect itself.** The fresh-session id was
  written to storage unconditionally, so a create that lost the race re-bound the
  panel to a conversation the user had just switched away from; it is now written
  only while its generation is current.
- **`detach` preserved the wrong rows.** A tool step row carries the id of the
  activity row it belongs to (`callId`), not its own, so matching on `id` dropped
  exactly the in-flight rows the parameter existed to keep.
- **`browser_type` reported success for changes that did not happen.** A disabled
  checkbox/radio accepted no click, and a checked radio cannot be unchecked, yet both
  answered "Checked/Unchecked". Disabled controls and the radio case are refused, and
  the state is verified after the click.
- **`browser_wait` text matching and budget.** The needle is whitespace-collapsed like
  `pageText` (a multi-line label could never match), the budget is clamped
  (`WAIT_MAX_BUDGET_MS`, since `1e999` parses to Infinity), and the default condition
  timeout is 10s rather than 15s because a cancelled call cannot interrupt the
  content-script poll.
- **A cancelled image recognition still hit the network.** `DirectRecognizer` lacked
  the `signal.aborted` pre-check that `BridgeRecognizer` had, so a request whose
  caller had already given up was sent anyway.
- **`browser_describe_image` coerced its arguments.** `Number(null)` is 0, so
  `index: null` described the first image; a bad `frame` silently became frame 0.
  Both are refused now, like the tool-dispatch path already did.
- **Snapshot baselines were never pruned** when a tab closed — one entry per tab ever
  snapshotted, for the life of the worker.
- **`pnpm run build` could not work on Node 24 + Windows at all.** `scripts/build.mjs`
  spawned `vite.cmd`, which returns `EINVAL` without a shell (and `shell: true` with an
  argument list is deprecated as DEP0190), and a failed spawn reported nothing, so the
  build exited 1 with no output. Vite is now run through `process.execPath` with its
  JavaScript entry point, and a failed spawn prints why.

### Known

- The 0.37 note below claimed a test asserted "exactly one WebSocket". That is no
  longer true: `background-session.spec.ts` asserts `toBeGreaterThan(0)` with the
  comment "At least one, not exactly one: … a test that counts dials fails for a
  legitimate retry". The assertion was relaxed, so the flakiness it described is
  gone and this entry is kept only to correct the record.
- **Nothing restores in-flight state across an MV3 worker restart.** Pending
  approvals, session grants and snapshot baselines live in memory only, so if the
  worker is stopped while a tool call waits on an approval (up to 120 s) the call is
  never answered and its panel card is gone. Conversations are unaffected — they are
  owned by the desktop side — but the model's call times out rather than resuming.
  Persisting approvals would mean persisting a decision the user has not made yet,
  which is worse than the timeout, so this is listed as a boundary rather than a bug.
- `approvalNotifications` remains a stored setting that the notification path
  bypasses by design (the panel is the notification surface when it is closed), and
  `visionThinking`/`visionTimeoutMs` exist only in the desktop plugin config, not in
  the extension's `Settings`. Both are deliberate; they are listed so a reader
  comparing the settings sheet with the storage schema does not read the difference
  as drift.

## [0.37]

A rewrite rather than a patch release. The packages were renamed and re-cut, so the
paths in the previous entry no longer describe this tree; both layouts are described
in the README.

### Added

- **Images can be read, when the user asks.** The model could describe a page but not
  a picture on it, which is what a product page, a chart or a screenshot of an error
  often is. The desktop now relays the image to the model the user configured, with
  four tiers — off, low, standard, enhanced — and **off by default**: nothing is
  fetched and nothing is sent until the user turns it on, and the panel's help text
  says why the recommendation is to leave it off, including what a look costs.
- **A benchmark that measures instead of describing.** Six tasks covering the shapes a
  browser agent meets (read, single action, form, search, multi-step, dynamic), run
  against a fixture site with seeded variation, comparing this extension with the
  runner's Playwright baseline on the same model and machine: success rate, completion
  time, tool calls and prompt tokens per task. Speed claims about a browser backend are
  only meaningful as a paired comparison, because the model dominates absolute time.
- **Continuous integration**, on the same steps a release uses: a frozen-lockfile
  install, a forced typecheck, the tests, and both extension targets. The build runs
  before the tests so that the two checks which skip without a build actually run.

### Changed

- **The layout.** `packages/browser/bridge-browser/` became `packages/bridge/`,
  `extensions/dsh-browser/` became `extension/`, and the wire contract moved into its
  own package, `packages/protocol/`.
- **The extension's network policy.** Its content security policy allowed loopback
  only, which meant the worker's own image fetch could never reach a real host: the
  desktop had to fetch instead, and the desktop cannot carry the user's cookies, so an
  image behind a login was unreadable. `connect-src` now also allows `https:` and
  `http:` for that one operation, and the store's permission justification says so,
  because a reviewer reads it next to the manifest.
- **One version across the tree.** The root, the protocol, the bridge and the extension
  all carry 0.37, so a plugin list, a manifest and a tag cannot disagree.

### Fixed

- **A store-listing assertion had been skipping itself.** It resolves the repository
  root two levels up; the path arithmetic taken from upstream was three, so it pointed
  above the repository and the check that the listing and `_locales/en` agree had
  never run. It runs, and it passes.
- **Asking about an image twice downloaded it twice.** The bytes were fetched before
  the cache was consulted — invisible while the policy refused every real host, and a
  real download per repeat once it did not.
- **`cancelPendingWork()` cleared a timer but not the dialing.** A client that was
  reconnecting opened a socket after the teardown meant to end it, and a `startBridge`
  already in flight created a fresh client. Cancellation now abandons that start and
  stops the client.

### Known

- One test in `background-session.spec.ts` was described here as asserting that
  exactly one WebSocket was opened, with the worker free to dial twice under load.
  The assertion was subsequently relaxed to "at least one" — see the 0.38 entry,
  which corrects this note. The dead `approvalNotifications` setting and the
  desktop-only `visionThinking`/`visionTimeoutMs` keys are likewise covered by the
  0.38 entry rather than repeated here.
