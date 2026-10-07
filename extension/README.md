# dsh Browser Extension (Chrome and Firefox MV3)

English | [中文](README.zh.md)

The **browser-operation end** of dsh. The desktop DSH app drives it: the model
reads and operates the page you already have open — extract content, click
elements, fill forms, scroll, navigate — inside your real browser, with your
login state, cookies, and sessions intact.

It also carries **its own conversation surface**: the panel is where you type to
the model and where its replies appear. It is a Chrome **side panel** (Firefox:
sidebar), so it stays open beside the page instead of closing when you click away,
and the desktop app is not needed to see or send a message — only to run the model.

## What the model can do

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text into a field (`replace` clears first), pick a `<select>` option (by value, visible label, or 1-based position), or set a checkbox/radio with `true`/`false` |
| Keys | `browser_press` | Enter/Tab/Escape/arrows and so on |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Inside the controlled tab, or open a URL in a new tab and follow it |
| List tabs | `browser_list_tabs` | Accessible tabs with stable IDs, titles, URLs, and state |
| Follow tab | `browser_follow_tab` | Bind later tools to a listed tab without activating it |
| Close tab | `browser_close_tab` | Close a listed tab |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Settle the page, or wait for a selector/text to appear (fails with `timeout` if it never does) |
| Start the browser | `browser_launch` | Runs on the **desktop** side: with no browser open there is no extension to dispatch to, so this is the one tool that starts it and then reports what it found |
| Describe an image | `browser_describe_image` | Answers only while image viewing is on; see "Image viewing" in the repository README |

That is the model-visible set of 17; the authoritative list is `BROWSER_TOOL_NAMES`
in `packages/bridge/src/tools.ts`.

Page state is always rendered as **structured text** — a numbered inventory of
interactive elements with stable numbers across snapshots. Browser tools never
take screenshots.

## Architecture

```
browser side panel / sidebar (composer + timeline; also the connection UI)
        │  port "dsh-control"
        ▼
background service worker
        │  WebSocket  ws://127.0.0.1:<port>/ext/bridge
        ▼
dsh bridge plugin (server side, inside the dsh process)
        │  browser_* tool calls and streamed replies
        ▼
dsh desktop window (the model runs here)
```

- **background** (`src/background/`): owns the bridge socket (token auth,
  auto-discovery, exponential-backoff reconnect, keepalive), fail-closed tool
  dispatch into a single user-controlled tab, tab affinity, approval
  coordination, the `session.*` conversation RPCs, and the `dsh-control` port
  protocol.
- **content script** (`src/content/`): text-only snapshot (readability main text
  + numbered interactive inventory + form fields), stable element numbers
  (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, and
  sensitive-field masking.
- **panel** (`control/`): a dependency-free vanilla-TS side panel showing the
  conversation, connection state, the controlled tab, approval cards, **the turn's
  task list**, a short activity log, the safety settings, and the bridge address. It
  stays open while you browse — the page beside it is the thing being operated.
  - The task list is how a multi-step request stays legible: the model writes the
    checklist it is about to run and re-emits it with the boxes ticked, and the panel
    shows it above the run with the task in progress, the finished ones and the
    failed ones marked. Each activity line also ends with what its tool actually did,
    so a completed step never looks like a pending one.
- **protocol**: the wire contract is the workspace package
  `@dsh-browser/protocol` (`packages/protocol/src/index.ts`, plus
  `vision-contract.ts`), inlined into both ends by the bundler so the two halves
  cannot drift.

## Build

From the repository root:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build            # Chrome/Edge -> dist/
pnpm --filter dsh-browser-extension run build:firefox    # Firefox     -> dist-firefox/
pnpm --filter dsh-browser-extension run test
pnpm --filter dsh-browser-extension run typecheck
```

## Install and use

1. Build (above), then load the output:
   - **Chrome/Edge**: `chrome://extensions` → enable Developer mode →
     *Load unpacked* → select `extension/dist/`.
   - **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary
     Add-on* → select `extension/dist-firefox/manifest.json`.
2. Make sure dsh is running with the bridge plugin mounted, then open any normal
   `http://` or `https://` page and click the whale icon to open the panel.
3. The panel shows the connection. Chrome/Edge loopback connections need no
   address or token — the bridge accepts them because they come from **this**
   extension, identified by its id. Firefox must be given the token from
   `~/.dsh/ext-bridge-token`, because a `moz-extension://` UUID is not an add-on
   identity, so the bridge cannot tell this extension from any other connection.
4. Talk to the model in the panel. Ask it to read or operate the page; the first
   call binds the tab you are looking at.

**Desktop DSH users**: the desktop app may assign a random local Web port. The
extension auto-discovers the usual ports (3080, 3081, 3090, 14389, 43189,
19387); if yours differs, paste `http://127.0.0.1:<port>` into the panel's
*Bridge address*. Pinning the port to `43189` in the desktop settings keeps
auto-discovery working.

Pages that were already open before the extension was installed or reloaded are
instrumented on the first action, so they need no manual refresh.
Browser-internal and protected pages (`chrome://`, the Web Store) expose only tab
metadata and browser-level navigate/back/forward/reload; their DOM cannot be read
or operated.

## How the connection works

- **Connects on load, not on click.** There is no button to press: the worker
  starts connecting as soon as settings are read, and a half-minute `alarms`
  heartbeat keeps both the socket and the MV3 worker alive. *Auto connect* in
  the panel is the one way to stop it.
- **One browser at a time.** A second open profile is told to yield (close code
  4000) instead of fighting for the slot.
- **Nothing is read from the page until a tool asks.** Snapshots and text reads
  are enclosed in a fresh nonce-bound trust marker that tells the model to treat
  page text as untrusted data.

## Approvals and safety

Approvals are the enforcement boundary, and the panel is not the only way to
answer one — the worker keeps running with it closed:

- The default `auto` mode lets the model read the controlled tab without an extra
  prompt; `ask` restores per-read confirmation; `off` blocks reads.
- State-changing tools fail closed and show their exact origin plus a redacted
  action summary. You may deny, allow once, or trust one origin for the current
  bridge session (the panel lists temporary grants and can revoke them).
- With the panel closed, an approval becomes a **system notification** and a **red
  badge count** on the toolbar icon. Clicking either opens the panel on that
  request. You have two minutes to decide.
- **Allow unrestricted browser control** is an explicit switch that only takes
  effect after the setting is saved, and then lets page reads, page actions, and
  tab list/follow/close run without confirmation. It is persisted, not per
  connection: it stays on until you turn it off. Protected-page DOM content stays
  inaccessible either way.
- A manual tab or window switch pauses later tools and asks whether to stay on
  the original page or follow the new one; *keep and stop asking* pins it.
  Closing the controlled tab fails closed until you bind the current page.
- Password and credit-card values always render as `••••` and never leave the
  page.

## Permissions

`storage` (settings, the image-description memo, and controlled-tab continuity),
`tabs` + `scripting` (observe tab changes and inject/message only the explicitly
controlled tab, including lazy recovery for pages opened before install),
`sidePanel` (Chrome only — the conversation surface; Firefox uses
`sidebar_action` instead), `webNavigation` (bind messages to that tab's frame
documents), `alarms` (background keepalive), `notifications` (approvals received
while the panel is closed), and `http/https` (content-script injection on normal
pages). There is no `activeTab`: the broad host permission is what actually grants
access, and `activeTab` was declared upstream without being used.

The extension never changes the visible tab or silently follows a manual switch;
background operation happens only after you choose to stay on the original page.

## Differences from the upstream build

Compared with the upstream `dsh-browser` extension this tree **removes** the React
client stack (session history, image attachments, model picker, update card,
text-selection quotes, `ask_user_question` cards, transient event replay, and the
whole gateway RPC channel) and **replaces** it with a dependency-free vanilla-TS
panel that keeps a conversation composer, a timeline, a desktop-session picker and
approval cards. It **adds** auto-connect, pending-approval replay, badge counts,
and a two-minute approval window. The bridge protocol is unchanged, so the same
dsh-side plugin serves both builds.

## Known limitations

- Only one extension connection at a time.
- Tab affinity is global to that connection, not per conversation: several chat
  sessions share one controlled tab.
- Captcha and image-only controls cannot be handled; the tool result asks you to
  complete that step manually.
- No automatic token rotation.
- Synthetic `browser_press` events do not trigger browser-native defaults such as
  Tab focus movement, arrow-key scrolling, or Enter activation.
- `browser_wait` without a condition considers page load plus a quiet window; a
  live-updating SPA may be reported as stable. With a `selector` or `text`
  condition it polls instead, and fails with `timeout` after 10 seconds by default
  (or after `ms` when that is given). The poll runs in the content script, so
  cancelling the tool call stops the caller waiting but not the poll — another
  reason the default is short.
- A `<canvas>` is never listed as an image: it has no address to fetch, so the
  snapshot leaves it out rather than reporting something unreadable.
