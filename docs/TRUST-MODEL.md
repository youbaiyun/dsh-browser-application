# Trust model

What this extension can reach, what it stores, and what decides whether it acts.
Written so that a person who does not want to read the source can still decide
whether to install it, and so that a reviewer can check each claim against a
named file.

Everything here was verified by reading the code and running the test suite at
the release named in [CHANGELOG.md](CHANGELOG.md). Where a claim is a limitation
rather than a guarantee, it says so.

## The one-line version

The extension talks to exactly one thing — a bridge on your own machine — and a
page never gets to decide what it does. Everything below is the detail behind
that sentence.

## Network: where data can go

There are three outbound calls in the whole extension. All three are in
`extensions/dsh-browser/src/`:

| Where | What it is | Destination |
|---|---|---|
| `background/bridge.ts` | the control channel to the desktop app | `ws://127.0.0.1:<port>/ext/bridge` |
| `background/index.ts` | probing whether a bridge is listening | `http://127.0.0.1:<port>/ext/bridge-config` |
| `background/index.ts` | the same probe, per candidate port | loopback |

There is **no analytics, no telemetry, no crash reporting, no update check, and no
remote fetch of any kind**. Nothing about your browsing is sent anywhere except
your own machine. This is the claim to check first if you are deciding whether to
trust the extension, and it is checkable in one search:

```bash
grep -rn "fetch(\|XMLHttpRequest\|sendBeacon\|new WebSocket\|EventSource" extensions/dsh-browser/src
```

### What that search does not cover, stated plainly

The bridge **address is a stored setting** (`bridgeUrl`), and the background reads
it if it is set. The panel deliberately does not expose the field — the settings
sheet offers only choices the Chrome-over-loopback path lets a user make — so
changing it requires editing the extension's own storage. But the capability
exists, inherited from upstream: a `bridgeUrl` pointing at a remote host would
send page text, tool calls and replies there.

That is the single largest thing this extension could be made to do that a user
would not expect. It is not reachable through the interface, and it is why this
document exists rather than a shorter one. If you want the strongest setting,
leave `bridgeUrl` empty and let discovery find the local bridge.

## Host access: which sites

`host_permissions` is `http://*/*` and `https://*/*`, and a content script
declares the same match set. In practice that means:

- **The content script is injected broadly**, because the extension cannot know in
  advance which tab you will point it at.
- **It is bounded at the other end.** Which tab is actually read and operated is
  chosen by you — the panel binds one tab, and the trust model refuses an action
  on any other. Broad injection, narrow authority.
- **Nothing runs until something asks.** Content scripts only take part in a
  snapshot or an action. There is no timer, and no background reader.
- **`chrome://`, `file://`, and other browser-internal pages are out of reach**,
  by browser policy rather than by choice here. `activeTab` was declared and never
  used, and was removed; the broad host permission is what actually grants access.

## Stored data: what stays on your machine

Kept in `chrome.storage.local`, which is per-profile and never synced:

| Key | What it holds |
|---|---|
| settings | your choices: panel behaviour, tab-switch mode, page-sharing mode |
| `dshFreshSessionId` | which conversation the panel is bound to, so it survives the worker being recycled |
| the bridge token | bearer credential for the local bridge |

Also local, in the desktop app's own storage rather than the browser's: the
conversations themselves. They live in the dsh workspace at
`~/.dsh/browser-sessions`, grouped under a workspace named 浏览器对话.

**Page text is sent to the desktop app and to the model you configured there.**
That is the feature. It is not sent anywhere else by this extension, and the
desktop side is governed by your dsh configuration, not by this repository.

## What never leaves the page

- **Password and payment-card field values are masked before the snapshot is
  built**, not filtered afterwards. `src/content/privacy.ts` decides: a
  `type="password"` input, an `autocomplete` of `credit-card` or anything starting
  `cc-`, and any field whose id, name or `aria-label` mentions `password`,
  `passwd`, `pwd`, `credit`, `card`, `cvv`, `cvc` or `secret`. A non-empty value
  becomes a fixed placeholder, so the model learns that a value is present
  without learning it.
- **Text typed into a `type` action is not echoed** into the approval prompt. The
  prompt reports the character count and says so explicitly
  (`src/background/authorization.ts`).
- **Files are never uploaded.** There is no `input[type=file]` handling, no
  `FileReader`, and no `DataTransfer` anywhere in the extension — searched, zero
  matches.
- **No screenshots, ever.** The page channel is text by construction, so there is
  no image that could contain a password field.
- **URLs are reduced to their origin** before being reported, because paths carry
  session identifiers.

If you find a value that should have been masked and was not, that is a security
report — see [SECURITY.md](../SECURITY.md).

## Who decides whether the model may act

Three gates, in order:

1. **You choose the tab.** The extension operates the tab you bound, not whatever
   is in front. A manual tab switch raises a prompt rather than silently moving.
2. **The site's trust state decides.** Reads and writes are separate kinds. A site
   you have allowed for reads is not thereby allowed for writes.
3. **Approval, unless you turned it off.** Clicking, typing and navigating fail
   closed: with no answer, nothing happens. Approvals appear in the panel, or as a
   system notification when the panel is closed.

Unrestricted access is a per-connection setting you have to switch on. It is off
by default.

## What the model can and cannot influence

- **Page content is untrusted input** and is labelled as such. A page that tries
  to give the model instructions is expected; a page that succeeds is a
  vulnerability.
- **Text typed in the panel carries an origin marker** so the model can tell it
  apart from page content. A route into a prompt that bypasses the marker defeats
  the mechanism entirely.
- **The model cannot type into the panel**, cannot open a dialog the panel draws,
  and cannot press a button you have not offered it.

## Code execution: is there any

None. There is no `eval`, no `new Function`, no string passed to a timer, no
remote script, and no `document.write`. The panel's markup comes from a DOM helper
or from Markdown that is sanitized twice over:

1. **DOMPurify with a narrow allowlist** — no `img`, `iframe`, `script`, or `style`,
   and links restricted to `http`/`https` so a `javascript:` or `data:` URL cannot
   survive (`control/markdown.ts`).
2. **A content security policy** of `script-src 'self'`, which makes an inline
   script or an event-handler attribute impossible even if the first layer missed
   something (`manifest.json`, and the panel inlines nothing).

Icons are a static table of SVG paths selected by a typed union, not by a string
from anywhere else.

## Known limitations

Stated because a trust document that only lists strengths is marketing:

- **The bridge token is a bearer credential on loopback.** Anything already
  running as you on your machine can read it and use the bridge. This protects
  against a web page, not against local malware.
- **A remote `bridgeUrl` is possible**, as described above.
- **The `data_collection_permissions` declaration for Firefox** lists
  `browsingActivity`, `websiteActivity`, `websiteContent` and
  `personalCommunications`. Those are accurate: the extension reads tab URLs and
  titles, reads page text including whatever happens to be on the page, and reads
  text you type into the panel. Firefox requires the broadest honest answer, not
  the narrowest arguable one.
- **Approval prompts are per-site, not per-element.** Allowing a site allows
  acting anywhere on it.
