# Publishing to the stores

Steps that cannot be automated, in order, with the parts that most often go
wrong called out.

## Before anything else

Two things must be true or the submission is rejected immediately:

1. **`dsh-browser-application` must be gone** from the repository. Run
   `pnpm --filter dsh-browser-extension run test:layout` — it reports every file
   still containing the placeholder.
2. **The name must not collide.** Upstream already holds `dsh Browser Control` on
   the Chrome Web Store. This build ships as `dsh Browser Extension`; the name
   comes from `extensions/dsh-browser/_locales/*/messages.json`, so change it
   there and rebuild rather than editing the built package.

## Build the upload package

```sh
pnpm install --frozen-lockfile
pnpm run build
cd extensions/dsh-browser/dist && zip -r ../../../dsh-browser-application-0.3.1.zip .
```

The store wants a ZIP of the **contents** of `dist/`, not the folder itself. On
Windows, select the files inside `dist` and send them to a compressed folder —
zipping `dist` produces an extra directory level and the upload fails as
"manifest not found".

## Chrome Web Store

### 1. Developer account

One-time US$5 registration at
https://chrome.google.com/webstore/devconsole. The account email becomes public
on the listing, so use an address you are content to publish, or a dedicated
one.

### 2. Create the item and upload

Upload the ZIP. The dashboard reports the manifest's version. **Every upload must
have a higher version than the last**, so bump `version` in both
`extensions/dsh-browser/manifest.json` and `package.json` before re-uploading —
a rejected upload still consumes the number.

### 3. Fill in the listing

Everything needed is in this directory:

- `store-listing.md` — name, descriptions, category, single-purpose statement
- `permission-justification.md` — the answer for every permission and the host
  pattern, plus the data-usage form

### 4. Privacy policy URL

Required. This one exists already, created 2026-10-03 as a secret gist so it is
reachable by anyone with the link but is not searchable:

```
https://gist.github.com/youbaiyun/92cd701036f39f168548f12c5ed171f6
```

Contents are `PRIVACY.md`. Verified reachable **without authentication** — the
HTML page and the raw file both return HTTP 200, which is the property that
matters: a store reviewer is not signed in to anything of yours, and a private
gist or a private repository file would fail their check.

**If the policy text ever changes**, edit the gist rather than creating a new one.
The store stores the URL, not the text, so a new gist means an outdated URL in a
live listing. Secret gists keep their revision history, so an edit is both
traceable and sufficient.

### 5. Screenshots

At least one at 1280×800 or 640×400. Not produced yet. Take them with the panel
open, in this order of usefulness to someone deciding whether to install:

1. A conversation with a tool line — what it is, at a glance. This is the one the
   listing shows by default.
2. An approval card — evidence that it asks before acting.
3. The settings sheet — evidence that the user keeps control.
4. `@open` having opened a page — the clearest single feature.
5. A page snapshot with numbered controls — how it reads a page without
   screenshots.

Stretch the browser window to at least 1280 wide before capturing, so the panel
and the page are both visible at the required size.

### 6. Submit for review

Reviews take days to weeks. The broad host permission (`http://*/*`,
`https://*/*`) is the usual cause of a longer review; the justification in
`permission-justification.md` is written to answer that specific concern, so give
it verbatim rather than paraphrasing.

## Firefox (addons.mozilla.org)

Separate submission, separate review.

```sh
pnpm --filter dsh-browser-extension run build:firefox
cd extensions/dsh-browser/dist-firefox && zip -r ../../../dsh-browser-application-0.3.1-firefox.zip .
```

Notes specific to Firefox:

- The add-on id in `manifest.firefox.json` must be yours. It is currently
  `dsh-browser-extension@youbaiyun.github.io`. **An id is permanent once submitted** —
  changing it later means a new listing, so confirm it before the first upload.
- Firefox declares `strict_min_version: 140.0`. The sidebar and
  `storage.session` this build uses need it.
- The manifest carries no `sidePanel` permission, which is correct: Firefox has
  no such API and uses `sidebar_action` instead.

## After publishing

- **Tag the release.** `git tag v0.3.0 && git push --tags` matches the manifest
  version to a point in history, which is the only way to answer "what exactly is
  in the store?" later.
- **Keep the version in one place in your head.** Three manifests carry versions
  — the extension's, the bridge plugin's, and the root package's. They evolve
  independently, and only the extension's is shown to a user. A test asserts the
  extension's three copies agree.
- **Watch the first reviews.** The panel's behaviour is unusual by design (no
  screenshots, approvals by default, a text-only page channel). If users read
  that as a limitation rather than a choice, the listing description is the thing
  to fix, not the extension.
