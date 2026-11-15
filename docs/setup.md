# Setup

This page covers installation, client registration, the connection to ShowKontrol and optional atomic session publication. For a first session after setup, see [Workflow](workflow.md).

## Requirements

- Node.js 20 or later.
- Optional, for atomic session publication: a Node.js 26 build with FFI support, started with `--experimental-ffi` (see [Atomic session publication](#atomic-session-publication)).
- ShowKontrol R27 with a licence that permits the requested operation.
- A running ShowKontrol web engine. Local plugin pairing or the web server must be enabled in ShowKontrol.
- For remote control over the web server, enable Allow Remote Control and configure an access token in ShowKontrol.

The last three items apply to live tools only. No credentials are needed for offline file tools, and offline tools work without a running ShowKontrol.

Review the network and token settings before you enable remote access. The manual describes a local-only plugin mode. During a local pairing test, the API reported `localOnly: true` while macOS reported a wildcard listener on port 8090; remote acceptance was not tested. Check network exposure on the target computer.

## Install

Run `npm ci` in this directory on the computer that will run the server. The server uses standard input and output for MCP; do not use the terminal for interactive commands while it runs. An MCP client starts it as `node server.js`. Use absolute paths in the client's configuration.

Run `command -v node` to find the Node.js executable. In the examples below, replace `/absolute/path/to/node` and `/absolute/path/to/showkontrol-mcp/server.js` with paths on the target computer.

The examples use local pairing; enable it in ShowKontrol first. For a network connection, see [Connect to ShowKontrol](#connect-to-showkontrol).

## Register with Claude Code

```sh
claude mcp add --scope user --transport stdio showkontrol -e SHOWKONTROL_USE_LOCAL_PAIRING=1 -- "/absolute/path/to/node" "/absolute/path/to/showkontrol-mcp/server.js"
```

`--scope user` makes the server available in all your projects and keeps its settings in your private Claude Code configuration. Do not use `--scope project` with a token: that scope writes a `.mcp.json` file that is meant to be shared.

Check the registration with `claude mcp get showkontrol`. It reports the connection status, and its output includes environment values in clear text; do not share it if it contains credentials.

## Register with Codex CLI

```sh
codex mcp add --env SHOWKONTROL_USE_LOCAL_PAIRING=1 showkontrol -- "/absolute/path/to/node" "/absolute/path/to/showkontrol-mcp/server.js"
```

Check the registration with `codex mcp get showkontrol`. The command writes this entry to `~/.codex/config.toml`, which you can also edit directly:

```toml
[mcp_servers.showkontrol]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/showkontrol-mcp/server.js"]

[mcp_servers.showkontrol.env]
SHOWKONTROL_USE_LOCAL_PAIRING = "1"
```

## Other MCP clients

A client that supports the common `mcpServers` configuration can use this entry:

```json
{
  "mcpServers": {
    "showkontrol": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/showkontrol-mcp/server.js"],
      "env": {"SHOWKONTROL_USE_LOCAL_PAIRING": "1"}
    }
  }
}
```

The exact configuration file and restart procedure depend on the MCP client.

## Check the connection

Restart the client if it does not show the tools. Then ask it to call `showkontrol_discover` to check live access. For offline work, call `showkontrol_inspect_show_overview` on a show file instead.

Registration evidence: on 15 November 2026 both registration commands above were run against empty client configurations on Linux, with Claude Code 2.1.300, Codex CLI 0.133.0 and Node.js 22.23.2. `claude mcp get` reported the server as connected, and an MCP client listed 120 tools and the `author_offline_show` prompt. The commands have not been run on macOS or on a computer with ShowKontrol, and that check did not reach a running ShowKontrol.

## Connect to ShowKontrol

Local pairing (`SHOWKONTROL_USE_LOCAL_PAIRING=1`) reads the current user's ShowKontrol Stream Deck pairing file and works only with a loopback URL. For a network connection, set `SHOWKONTROL_URL` and supply `SHOWKONTROL_TOKEN` through the client's private environment. Never commit a token.

### Environment variables

- `SHOWKONTROL_URL`: HTTP(S) origin. Default: `http://127.0.0.1:8090`.
- `SHOWKONTROL_TOKEN`: access token, if required. Store this in the client's private environment, not in a shared configuration file.
- `SHOWKONTROL_USE_LOCAL_PAIRING=1`: read the current user's ShowKontrol Stream Deck pairing file. This only works with a loopback URL. The file must be enabled. When no URL is specified, its port is used.
- `SHOWKONTROL_PAIR_KEY`: explicit local pairing key, if required.
- `SHOWKONTROL_PAIRING_FILE`: path of the pairing file read with `SHOWKONTROL_USE_LOCAL_PAIRING=1`. Default: `~/Documents/TC Supply/WEB/streamdeck.json`.
- `SHOWKONTROL_TIMEOUT_MS`: request timeout from 100 to 120000 milliseconds. Default: 5000.
- `SHOWKONTROL_OFFLINE_MAX_BYTES`: maximum offline XML input or output size in bytes. Default: 134217728 (128 MiB). This does not change the 5 MiB live API response limit. Raw XML and part inspection can return large MCP messages; client limits may be lower.
- `SHOWKONTROL_SESSION_MEDIA_MAX_BYTES`: maximum total bytes that one `showkontrol_compose_session_media_copy` call copies, as a positive integer. Default: 4294967296 (4 GiB). See [Session directories](reference.md#session-directories).

## Atomic session publication

`showkontrol_compose_session_media_copy` publishes a new session directory. It uses a no-replace rename when the experimental `node:ffi` module is available, and otherwise falls back to a `mkdir` claim and rename that another process can still race. The result's `publication` says which method was used and why. The details are in [Session directories](reference.md#session-directories).

Atomic session publication needs the experimental `node:ffi` module. Node.js 26.1.0 through 26.8.1 provide it only in builds with FFI support and only when Node.js is started with `--experimental-ffi`. The version alone does not enable it, and the server never adds the option. Without it the server runs as before and publishes sessions with the `claim_rename` fallback; the result's `publication.fallbackReason` says that the option is missing. To enable it, put the option before the script path:

```json
"args": ["--experimental-ffi", "/absolute/path/to/showkontrol-mcp/server.js"]
```

```sh
codex mcp add --env SHOWKONTROL_USE_LOCAL_PAIRING=1 showkontrol -- "/absolute/path/to/node" --experimental-ffi "/absolute/path/to/showkontrol-mcp/server.js"
claude mcp add --scope user --transport stdio showkontrol -e SHOWKONTROL_USE_LOCAL_PAIRING=1 -- "/absolute/path/to/node" --experimental-ffi "/absolute/path/to/showkontrol-mcp/server.js"
```

Add it only for a Node.js that accepts it. Node.js 22 exits at startup with `bad option: --experimental-ffi`, and refuses it in `NODE_OPTIONS` too, so a client configured that way shows no tools; older Node.js and builds without FFI support behave the same way. Registered against Node.js 22.23.2, both variants above were accepted by the clients, and `claude mcp get` then reported that the server failed to connect. To check the executable the client uses, run `"/absolute/path/to/node" --experimental-ffi -e "console.log(typeof process.getBuiltinModule('node:ffi'))"`, which prints `object` when the module is available. Then `SHOWKONTROL_EXPECT_ATOMIC_PUBLICATION=1 "/absolute/path/to/node" --experimental-ffi --test session-publication.test.js` in this directory checks the no-replace rename in the system temporary directory. The probe at each call checks the destination's own volume. The option enables a module that can call native code, and Node.js marks it experimental. Under the permission model (`--permission`), `node:ffi` also requires `--allow-ffi`. Neither variant has been registered with a Node.js that provides `node:ffi`.

## Troubleshooting

- **The client shows no tools.** Run `claude mcp get showkontrol` or `codex mcp get showkontrol`. Check both absolute paths and that `npm ci` ran in the project directory. If the arguments include `--experimental-ffi`, check that this Node.js accepts it (see above).
- **Live tools fail but offline tools work.** Check that the ShowKontrol web engine is running and that local pairing or the web server is enabled. With local pairing, `SHOWKONTROL_URL` must be a loopback URL.
- **A live write timed out.** The change may have been applied. Read the live state before you repeat the write. REST calls are not retried.
- **Session results report `claim_rename`.** Read `publication.fallbackReason`. Set `requireAtomicPublication: true` to make the call fail instead of using the fallback.
