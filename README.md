# ShowKontrol MCP bridge

A local Model Context Protocol (MCP) server for ShowKontrol R27. It gives compatible clients access to the ShowKontrol REST API and tools for inspecting and editing supported offline show files. It can also generate REAPER projects for manual import.

This is an early bridge. It does not cover the complete show format or prove that an edited show will load or run. Live commands can change a show and control equipment. Work on copies, inspect results, and test them in ShowKontrol before use.

The server can inspect shows, timelines, cues, patch graphs, and Programs. It can create offline copies with supported edits and compose tracks and cues from inspected templates. Live tools can inspect and change nodes, parameters, and connections. REAPER project generation supports a manual import workflow. See the [reference](docs/reference.md) for the evidence and limits of each operation.

## Requirements

- Node.js 20 or later.
- ShowKontrol R27 with a licence that permits the requested operation.
- A running ShowKontrol web engine. Local plugin pairing or the web server must be enabled in ShowKontrol.
- For remote control over the web server, enable Allow Remote Control and configure an access token in ShowKontrol.

Review the network and token settings before you enable remote access. The manual describes a local-only plugin mode. During a local pairing test, the API reported `localOnly: true` while macOS reported a wildcard listener on port 8090; remote acceptance was not tested. Check network exposure on the target computer.

## Run

Run `npm ci` in this directory, then start `node server.js` through an MCP client. Use the absolute path to `server.js` in the client's configuration. The server uses standard input and output for MCP; do not use the terminal for interactive commands while it runs.

For example, a client that supports the common `mcpServers` configuration can use this entry:

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

Replace both paths with paths on the target computer. Run `command -v node` to find the Node.js executable. Install the project there with `npm ci`. The exact configuration file and restart procedure depend on the MCP client. This example uses local pairing; enable it in ShowKontrol first. For a network connection, set `SHOWKONTROL_URL` and supply `SHOWKONTROL_TOKEN` through the client's private environment. Never commit a token.

For Codex CLI, replace the two example paths and run:

```sh
codex mcp add --env SHOWKONTROL_USE_LOCAL_PAIRING=1 showkontrol -- "/absolute/path/to/node" "/absolute/path/to/showkontrol-mcp/server.js"
```

For Claude Code, replace the two example paths and run:

```sh
claude mcp add --scope user --transport stdio showkontrol -e SHOWKONTROL_USE_LOCAL_PAIRING=1 -- "/absolute/path/to/node" "/absolute/path/to/showkontrol-mcp/server.js"
```

These commands register a local stdio server. Use `codex mcp get showkontrol` or `claude mcp get showkontrol` to inspect the registration. The output can include environment values; do not share it if it contains credentials. Restart the client if it does not show the tools. Use `showkontrol_discover` to check the connection. The CLI options were checked against the installed clients; these exact registration commands have not been run on a clean computer.

Environment variables:

- `SHOWKONTROL_URL`: HTTP(S) origin. Default: `http://127.0.0.1:8090`.
- `SHOWKONTROL_TOKEN`: access token, if required. Store this in the client's private environment, not in a shared configuration file.
- `SHOWKONTROL_USE_LOCAL_PAIRING=1`: read the current user's ShowKontrol Stream Deck pairing file. This only works with a loopback URL. The file must be enabled. When no URL is specified, its port is used.
- `SHOWKONTROL_PAIR_KEY`: explicit local pairing key, if required.
- `SHOWKONTROL_TIMEOUT_MS`: request timeout from 100 to 120000 milliseconds. Default: 5000.
- `SHOWKONTROL_OFFLINE_MAX_BYTES`: maximum offline XML input or output size in bytes. Default: 134217728 (128 MiB). This does not change the 5 MiB live API response limit. Raw XML and part inspection can return large MCP messages; client limits may be lower.

No credentials are needed for offline file tools.

## Start using the tools

After connecting the client, ask it to call `showkontrol_discover` to check live access. For offline work, no credentials or running ShowKontrol instance are needed. Ask the client to inspect the source first, create a new copy, and inspect and validate that copy. The `author_offline_show` MCP prompt provides a workflow for clients that support prompts.

A successful API response does not prove that an action had its intended effect. Check the relevant live state. REST calls are not retried; after a timeout, inspect state before repeating a write.

See the [tool and validation reference](docs/reference.md) for tool descriptions, file formats, examples, and the limits of the tests performed. The server's MCP tool schemas are the source of the accepted arguments.

## Test and contribute

Run `npm test`. The suite uses mock servers and temporary files; it does not change a live show. Mock tests do not prove compatibility with ShowKontrol. To include the optional app-reserialized audio timeline test, set `SHOWKONTROL_AUDIO_FIXTURE` to the path of a suitable `.sktl` file. An invalid path fails the test.

See [Contributing](CONTRIBUTING.md) for development and test guidance.

## References

- [ShowKontrol Remote Control & API](https://manual.showkontrol.com/manual/remote)
- [ShowKontrol Cue Editor & Timelines](https://manual.showkontrol.com/manual/timeline)
- [REAPER state chunk definitions](https://github.com/ReaTeam/Doc/blob/master/State%20Chunk%20Definitions)

### Media inventory

`showkontrol_inspect_show_media` reads `media.map`, archive part metadata, and audio clips from standalone and Program item timelines. It does not open referenced paths. `timelines` reports the root media fields found in the app-saved empty track fixture. Each value has a character length; values longer than 4,096 characters are omitted. The meaning of nonempty values has not been verified in the app.

Each timeline and clip has `attributeMappings`: the names of attributes whose decoded values exactly match a source or archive path in `media.map`, with the matching line numbers. Matches are case-sensitive. A match does not prove that the app uses that attribute as a media link. For compatibility, a clip's `mappingLines` still reports matches for its `file` attribute only. `audioIndex` identifies the lane, and `clipIndex` is zero-based within that lane. Missing matches or archive parts do not establish that media is broken. The tool does not check playback or external files.
