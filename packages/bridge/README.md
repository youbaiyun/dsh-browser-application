# dsh-browser-crossplatform

The desktop half of the dsh browser extension. It mounts a token-authenticated
WebSocket bridge on the desktop app's own webserver, exposes the `browser_*` tools to
the model, and relays image recognition to the model the user configured.

Part of [dsh-browser-crossplatform](https://github.com/youbaiyun/dsh-browser-crossplatform).
Install it into a dsh profile rather than by hand:

```sh
# the profile your desktop app runs (the app uses `desktop`; the CLI uses `web`)
dsh plugin --profile desktop add dsh-browser-crossplatform
```

Its settings page carries every knob — `visionBaseUrl`, `visionModel`,
`visionThinking`, `visionTimeoutMs`, the session workspace, the tool timeout — each
with a one-line description. The repository README has the table.

**适配范围**：Windows / macOS / Linux 上的 dsh 桌面端（Node ≥ 20）+ 桌面 Chrome / Chromium / Edge **116+** 或 Firefox **140+**；**手机与平板不支持**（没有侧边栏这种界面，且桥接只回环）。

Three things worth knowing before you enable anything:

- **The bearer token** is generated on first boot and persisted at
  `~/.dsh/ext-bridge-token` with mode 0600. `DSH_EXT_TOKEN` pins a fixed one.
- **Image recognition is off** until the user enables a tier in the extension's panel.
  When it is on, the extension fetches the image the user asked about and this plugin
  sends it to the model configured above.
- **The bridge answers on loopback only**, regardless of the token.

MIT. The upstream notice is preserved in `LICENSE`.
