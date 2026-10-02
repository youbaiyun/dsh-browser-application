# Agent Note: Standalone npm browser workspace

Status: implemented

English | [中文](2026-08-13-standalone-npm-workspace.zh.md)

## Problem

The browser bridge repository depended on a sibling DeepSeek Harness source checkout for TypeScript project references, workspace dependencies, test resolution, and the `dsh` executable. That topology prevented the repository from installing, building, testing, or running against a published npm release by itself.

## Decision

The repository is one pnpm workspace containing the bridge package and Chrome extension. Its root manifest installs a pinned `@deepseek-ai/dsh` release candidate, and the bridge package consumes the matching published `@deepseek-ai` packages through ordinary peer and development dependencies.

Published SDK packages use the scoped Cordis and Schemastery identities. Bridge source and tests import those scoped packages directly so Cordis service declaration merging and runtime class identity remain singular. The bridge follows the published service names, including `webServer`, `workspaceRegistry`, `userQuestions`, and `dsh-home-paths`.

The extension depends on the local bridge workspace package and imports the protocol through its `./src/*` export. The root build orders the bridge before the extension, while the bridge's built `protocol` export remains available to external consumers.

The published `dsh` launcher resolves out-of-tree plugins from the selected profile rather than the invoking workspace. The installer therefore registers the built local bridge package with the `web` profile. The package's profile-layer activation contract is owned by the [browser profile bundle decision](2026-08-14-browser-profile-bundle.md).

The project `.npmrc` selects the public registry without carrying credentials. The workspace explicitly allows only the install scripts required by the pinned dsh runtime and extension build.

## Alternatives considered

**Keep the host-checkout symlink.** This preserved source-level development but made the external repository non-installable and coupled every command to an unrelated parent workspace, defeating npm release validation.

**Alias scoped Cordis packages under their former unscoped names.** This preserved import spelling but could install two module identities beside published Harness packages, breaking Context declaration merging and class compatibility. Direct scoped imports keep one runtime and type identity.

## Verification

The root `typecheck`, `build`, and `test` scripts cover both workspace packages. The bridge suite boots the published Loader and Harness services, and its Chromium test exercises discovery, WebSocket authentication, gateway RPC, deferred session creation, and workspace grouping through the built extension. Startup smoke tests boot the registered `web` profile through both the workspace-pinned launcher and the public npm launcher, then read the discovery endpoint.

## Consequences

A clean checkout installs and runs without Harness source or npm credentials, and the lockfile records the complete public npm dependency graph. Updating the npm release requires coordinated manifest, API, lockfile, and end-to-end verification changes. Installation executes the explicitly allowlisted native build steps pulled in by the dsh runtime.
