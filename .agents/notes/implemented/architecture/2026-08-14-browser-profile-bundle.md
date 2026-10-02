# Agent Note: Browser profile bundle

Status: implemented

English | [中文](2026-08-14-browser-profile-bundle.zh.md)

## Problem

Installing the bridge as a plain profile dependency made its JavaScript resolvable but did not mount it in the `web` composition. The repository compensated with a root `--patch` file, so `pnpm start` could load the bridge while the standard `npx @deepseek-ai/dsh web` command could not. The two launchers therefore had different behavior and the bridge activation contract lived outside its package.

## Decision

The bridge package declares `dsh.bundle.patch` as `./cordis.patch.yml`, exports that file, and includes it in the published file set. The installer adds the linked package to the local `web` profile, allowing the Harness profile manager to register its patch layer.

`pnpm start` runs the workspace-pinned `dsh web`, while `npx @deepseek-ai/dsh web` runs npm's current public release. After installation, both commands resolve the same local profile bundle without a repository-relative `--patch` argument.

The bridge build invokes `tsdown` through the workspace script path. Runtime configuration, build tools, and plugin code all live inside this repository or its declared package graph; no command resolves dependencies from a parent checkout or parent `node_modules` directory.

The installer supports two source modes before running the same build and registration path. When it resides in a complete checkout, it uses that checkout and never downloads or overwrites source files. When streamed without a workspace, it downloads the `main` archive into the installer-owned `~/.dsh/dsh-browser` directory, validates the workspace shape, and re-executes the installed copy. A marker distinguishes the managed directory from user-owned content; remote installation refuses to overwrite a non-empty unmarked directory.

The managed workspace persists because the `web` profile links the bridge package by its local path. Re-running the remote command refreshes that workspace while retaining pnpm's `node_modules`; re-running a cloned installer continues to use its current branch.

The installer updates the stable unpacked-extension directory in place and distinguishes first installation from reloads. The extension treats the former loopback default as automatic discovery, probes a local bridge before opening each WebSocket, and retries discovery when the panel opens or the keepalive alarm fires. This avoids routine connection-refused errors while dsh is absent and connects after it becomes available.

## Alternatives considered

**Keep the root overlay and document an extra npx flag.** This would preserve two activation paths and would not make the standard npm command work as documented by Harness.

**Copy the patch into both the root and the package.** Duplicate configuration could drift or mount the plugin twice. The package owns the single profile layer.

**Require every user to clone the repository.** A clone is useful when editing or selecting branches, but Git and checkout management are unnecessary for ordinary installation. The managed archive preserves the local package path required by profile linking without exposing that workflow to users.

## Verification

A clean lockfile install checks the public release dependency graph. Package assembly confirms that `cordis.patch.yml` is included. An isolated-home shell smoke exercises both workspace detection and streamed bootstrap, including managed updates and refusal to overwrite an unmarked path. Isolated-home startup smokes add the bundle to a fresh `web` profile, boot both `pnpm start` and `npx @deepseek-ai/dsh web`, and require a successful `/ext/bridge-config` response. Extension tests require a successful availability probe before constructing a loopback WebSocket.

## Consequences

The installer must run once for each dsh home that should expose browser control. Managed installation trades Git-free onboarding for an installer-owned source directory that users must not treat as a working copy; developers retain ordinary clone semantics. The unversioned remote command follows the repository's current `main`, and the unversioned npx command follows npm's current dist-tag, so release changes still require compatibility verification; the workspace lockfile remains the reproducible dependency path for each selected source revision.
