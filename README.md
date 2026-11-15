# ShowKontrol MCP bridge

A local Model Context Protocol (MCP) server for ShowKontrol R27. It gives compatible clients access to the ShowKontrol REST API and tools for inspecting and editing supported offline show files. It can also generate REAPER projects for manual import.

This is an early bridge. It does not cover the complete show format or prove that an edited show will load or run. Live commands can change a show and control equipment. Work on copies, inspect results, and test them in ShowKontrol before use.

The server can inspect shows, timelines, cues, patch graphs, and Programs. It can create offline copies with supported edits and compose tracks and cues from inspected templates. Live tools can inspect and change nodes, parameters, and connections. REAPER project generation supports a manual import workflow. See the [reference](docs/reference.md) for the evidence and limits of each operation.

## Requirements

- Node.js 20 or later.
- Optional, for atomic session publication: a Node.js 26 build with FFI support, started with `--experimental-ffi` (see Run).
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

Atomic session publication (see `showkontrol_compose_session_media_copy`) needs the experimental `node:ffi` module. Node.js 26.1.0 through 26.8.1 provide it only in builds with FFI support and only when Node.js is started with `--experimental-ffi`. The version alone does not enable it, and the server never adds the option. Without it the server runs as before and publishes sessions with the `claim_rename` fallback; the result's `publication.fallbackReason` says that the option is missing. To enable it, put the option before the script path:

```json
"args": ["--experimental-ffi", "/absolute/path/to/showkontrol-mcp/server.js"]
```

```sh
codex mcp add --env SHOWKONTROL_USE_LOCAL_PAIRING=1 showkontrol -- "/absolute/path/to/node" --experimental-ffi "/absolute/path/to/showkontrol-mcp/server.js"
claude mcp add --scope user --transport stdio showkontrol -e SHOWKONTROL_USE_LOCAL_PAIRING=1 -- "/absolute/path/to/node" --experimental-ffi "/absolute/path/to/showkontrol-mcp/server.js"
```

Add it only for a Node.js that accepts it. Node.js 22 exits at startup with `bad option: --experimental-ffi`, and refuses it in `NODE_OPTIONS` too, so a client configured that way shows no tools; older Node.js and builds without FFI support behave the same way. To check the executable the client uses, run `"/absolute/path/to/node" --experimental-ffi -e "console.log(typeof process.getBuiltinModule('node:ffi'))"`, which prints `object` when the module is available. Then `SHOWKONTROL_EXPECT_ATOMIC_PUBLICATION=1 "/absolute/path/to/node" --experimental-ffi --test session-publication.test.js` in this directory checks the no-replace rename in the system temporary directory. The probe at each call checks the destination's own volume. The option enables a module that can call native code, and Node.js marks it experimental. Under the permission model (`--permission`), `node:ffi` also requires `--allow-ffi`. These two variants of the registration commands have not been run.

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

`showkontrol_compose_session_media_copy` writes a new session directory. It contains the composed `session.skshow`, new `media.map` rows, verified `MEDIA/` copies of existing and new sidecars, and the source session's working files, rewritten where they are exact extractions of changed archive parts. It accepts the tracks, patch, set-list and Program inputs of `showkontrol_compose_full_show_copy`, so one call can compose a complete show with new media into a session, and it does not publish a composed session that fails show validation. It fails rather than keep working state that disagrees with the composed archive. It does not modify the source session. Existing audio clips can be re-pointed to new or mapped media (`audioClipEdits` with `mediaIndex` or `file`), and clips and lanes can be removed (`audioClipRemovals`, `audioLaneRemovals`). Ordered Program edits can add, edit and remove lanes and clips in existing Program item timelines, and their clip additions and edits also accept `mediaIndex`. `media.map` rows and sidecars are kept unless `mediaMapOperations` removes or re-points a row, and rows no clip names any more are reported. A row can be removed or re-pointed only when nothing in the composed archive or in a carried working file still names a value that leaves the map; a sidecar left without a row is kept or omitted as `removedSidecars` says. `showkontrol_inspect_session_media` lists the lanes and clips with their mapped sidecars, and the `MEDIA/` files no row names. ShowKontrol has not opened or played a generated session; see the [reference](docs/reference.md) for limits.

The new session is published with a no-replace rename (`renameat2` `RENAME_NOREPLACE` on Linux, `renamex_np` `RENAME_EXCL` on macOS) when the running Node.js provides the experimental `node:ffi` module and a probe on the destination volume confirms that the rename refuses an existing directory. Node.js 26.1.0 through 26.8.1 provide `node:ffi` only when started with `--experimental-ffi` (see Run); the server does not add the option. Otherwise it falls back to a `mkdir` claim and rename, which another process can still race; the result's `publication` says which method was used and why. Set `requireAtomicPublication` to refuse the fallback. A killed call leaves a `.showkontrol-session-staging-*` directory with an owner record beside the destination. `showkontrol_find_session_staging` reports which ones are verifiably stale, and `showkontrol_remove_stale_session_staging` removes only those, after moving each to a `.removing-` name and checking that it is still the verified directory.

`showkontrol_preflight_session_audio` checks the media behind every track and Program audio clip in a session without writing. For each clip it reports the mapped `MEDIA/` sidecar and the clip's `file` as a path on this computer: whether each opens as a readable regular file, which clips share a file, and the ffprobe duration of the opened file within a shared time budget. Missing ffprobe, failed probes and an exhausted budget stay `unavailable`, `unknown` or `not_checked`. Trim attributes are returned as stored and are not compared with duration, because one app-saved import does not establish their unit and meaning. Which candidate ShowKontrol uses, and playback, are not verified.

`showkontrol_add_media_mappings_copy` appends literal rows to the existing `media.map` of a show copy, or with `createMediaMap: true` creates the missing part in the form the session composer writes. It keeps the other parts and rows byte-identical and rejects sources that are already mapped and sidecar names that would collide on a case-insensitive volume. It reports matching archive parts and clips for each new row. It does not copy media or create sidecars; ShowKontrol has not loaded a mapping added this way, or a show whose `media.map` was created this way.

`showkontrol_edit_media_mappings_copy` removes or re-points existing `media.map` rows of a show copy. Each row is selected by line and both exact values, and the call fails if another part still names a value that would leave the map. Other rows and parts stay byte-identical, and `MEDIA/` archive parts are kept and reported when no row names them. Whether ShowKontrol needs a removed row is unverified.
