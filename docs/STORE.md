# Submitting to a browser extension store

The groundwork for a store submission, and the two things that actually reject an
upload. Read this before opening a dashboard; the copy to paste is in
`store-assets/`.

## 1. Build the archive a store will accept

```sh
pnpm --filter dsh-browser-extension run build:store             # Chrome → dist-store/
pnpm --filter dsh-browser-extension run build:store:firefox     # Firefox → dist-firefox-store/
pnpm --filter dsh-browser-extension run package                 # writes the zips into the repo root
```

That produces four archives, and **the name says which one to upload**:

| Archive | Manifest `key` | Upload to |
|---|---|---|
| `dsh-browser-crossplatform-<version>-store.zip` | absent | **Chrome Web Store** |
| `dsh-browser-crossplatform-<version>-store-firefox.zip` | absent | **Firefox AMO** |
| `dsh-browser-crossplatform-<version>.zip` | present | nobody — load unpacked in a development browser |
| `dsh-browser-crossplatform-<version>-firefox.zip` | absent | nobody — Firefox dev build |

### Why the `key` has to go

The repository's manifests carry a `key` (an RSA public key). It pins the
extension id: the id is derived from it, which is why every development install
gets the same id (`kdhkdgfcinfkmogifamoapmheihhcjfk`) and why the bridge can
recognise the extension on its token-free loopback path.

A store refuses it. The Chrome Web Store's own wording, on the upload screen:

> 清单文件中不得包含"key"字段。

So the `--store` builds drop the field and nothing else. The store then assigns
the id itself.

### The consequence to expect

**A store install has an id the bridge has never seen**, so the token-free path
does not apply to it: the connection is rejected until a token is supplied. That
is the bridge's `extensionId` setting, whose default is
`DEFAULT_EXTENSION_ID` in `packages/bridge/src/index.ts`.

After the first accepted upload, the dashboard shows the assigned id. Put it in
that constant (alongside the existing one, or replacing it once the store listing
is the primary way people install) so a store install connects without a token.
Until then, a store user can paste the token from `~/.dsh/ext-bridge-token` into
the panel's settings, which is what the Firefox path already requires.

## 2. Fill in the listing

Copy-paste source for every field: `store-assets/store-listing.md` (name, short
description, detailed description), `store-assets/submission-form-field-by-field.md`
(field-by-field, including the URLs) and
`store-assets/permission-and-data-disclosure.md` (the per-permission argument).

Three things that are easy to get wrong:

- **The name must match `_locales`.** The manifest carries `__MSG_extensionName__`,
  so the store shows whatever the locale files say; a listing name typed by hand
  can disagree with the installed extension.
- **The short description is asserted equal to `_locales/en`** by
  `extension/tests/locales.spec.ts`, and the store's limit is 132 characters. Copy
  it from `store-listing.md` rather than retyping it.
- **Firefox declares more than Chrome.** `manifest.firefox.json` declares four
  `data_collection_permissions`; the AMO form must repeat all four. Copying Chrome's
  single tick across is what gets a submission bounced.

## 3. Data practices

Tick **only** "website content" in Chrome's form; see
`store-assets/permission-and-data-disclosure.md` for the reasoning and the exact
wording. The privacy policy URL must serve the **current** `PRIVACY.md` — the
form points at a gist, and a gist that still says "the extension fetches the
image" without the direct-endpoint path is a disclosure that no longer matches the
code.

## 4. Screenshots

1–5 images at 1280×800 or 640×400, captured from a real session. They are not in
this repository: the dashboard wants the upload, and a committed screenshot goes
stale silently. Worth showing, in this order: the task list mid-run, a page read
as the numbered inventory, an approval card, and an image description.
