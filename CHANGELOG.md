# Changelog

This project is a derivative of
[Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser). Upstream releases
are listed only where this fork has something to say about them; see
[COPYRIGHT.md](COPYRIGHT.md) for which files belong to whom.

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
- **`skills/dsh-browser-control/`.** A troubleshooting skill the model reads when
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
