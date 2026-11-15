# ShowKontrol MCP bridge

This server connects an MCP client to the ShowKontrol R27 REST API. It also creates REAPER project files for manual import into the Cue Editor. It is an early bridge, not a complete show-authoring system.

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

## Tools

- `showkontrol_read`: call a JSON or text GET endpoint under `/api/v1`.
- `showkontrol_read_binary`: read a binary endpoint as an embedded base64 resource, limited to 5 MiB.
- `showkontrol_sample_events`: sample the event stream for up to 30 seconds and 100 events. The server can replay the most recent event of each type when the connection starts.
- `showkontrol_write`: call a POST, PUT, PATCH or DELETE endpoint with a JSON body. Discover the endpoint and its schema first. This tool can change the show and control equipment.
- `showkontrol_discover`: read live state, status, nodes, available node types, settings, variables, or the patch.
- `showkontrol_get_deck`, `showkontrol_deck_command`: read a deck or send a documented transport command.
- `showkontrol_run_action`, `showkontrol_session_command`: run an action, launch the show, or switch a screen. The manual does not specify all request bodies; supply the body expected by the running app. These calls can control equipment.
- `showkontrol_get_parameter`, `showkontrol_set_parameter`, `showkontrol_set_setting`, `showkontrol_fire_node`: common node and setting operations.
- `showkontrol_node_type_detail`, `showkontrol_create_node`, `showkontrol_delete_node`: inspect a node type and preview, create, or delete a node. Creation requires an explicit `dryRun` value.
- `showkontrol_list_connections`, `showkontrol_create_connection`, `showkontrol_delete_connection`: list and edit connections by node ID and pin name or index. Creation requires an explicit `dryRun` value.
- `showkontrol_validate_patch`: send a patch specification with `dryRun: true` for app-side validation.
- `showkontrol_get_patch`, `showkontrol_put_patch`: read or submit the whole running patch. Supply the app’s expected JSON body.
- `showkontrol_inspect_timeline`: inspect the root metadata, layers, audio entries and cue element paths in an offline version 1 `.sktl` file.
- `showkontrol_add_timeline_cue_copy`: add a simple cue to a new offline timeline copy. Layer indices start at zero; start and length are in milliseconds. The source checksum must match and the destination must not exist. The shape comes from an app-created cue. In a separate test session, ShowKontrol R27 27.0.11 loaded a generated copy and displayed the added cue at 5 seconds with a 2-second duration. This tool does not create an action graph.
- `showkontrol_add_show_timeline_cues_copy`: add up to 100 simple cues to a new show copy. The destination filesystem must support hard links. The operation does not create action graphs.
- `showkontrol_inspect_cue_graph`: inspect the graph nodes, connections and settings of a cue in an offline timeline or show archive.
- `showkontrol_remove_cue_graph_copy`: remove a cue's graph in a new timeline or show copy. It preserves the cue. External references and app acceptance are not checked.
- `showkontrol_edit_cue_graph_wire_copy`: add or remove a pin-0 cue graph connection between the node types seen in the fixture. Pin compatibility outside those cases and app acceptance remain unverified.
- `showkontrol_compose_show_copy`: create a track, add cues, optionally copy supported graphs from donor shows, and optionally add the track to an existing set. Each cue can choose a donor or omit its graph. The operation creates an offline copy and requires hard-link support. It does not author media. In one test, ShowKontrol loaded generated timeline and set-list parts from the session directory and displayed the new track, its two cues, and its set-list position. Graph execution and opening the composed archive itself remain unverified.
- `showkontrol_compose_multi_track_show_copy`: compose up to 20 tracks in one offline copy using the same track and cue options. It does not author media and requires hard-link support. This multi-track operation remains unverified in the app.
- `showkontrol_edit_cue_graph_setting_copy`: change an existing node setting in a cue graph in a new copy. Inspect first. The tool does not validate the value or create a missing setting. ShowKontrol acceptance remains unverified.
- `showkontrol_add_cue_graph_setting_copy`: add a missing fixture-supported setting to a cue graph node in a new copy. Only `trigger.path`, `trigger.on` and `action.category` on their corresponding node types are supported. Values and app acceptance remain unverified.
- `showkontrol_copy_cue_graph_show_copy`: copy a graph from a cue in the same or another show to an empty cue in a new show archive. Set `sourceName` to select the source timeline and `name` for the target timeline. For a separate show, also set `template` and its inspected `templateSha256`. It supports only the group input, trigger and action node types seen in the test fixture. It scans target `.skf`, `.sktl`, and `.sksc` XML parts for node IDs and remaps graph nodes and connections. It rejects unsupported references. Reopening its output in the app remains unverified.
- `showkontrol_copy_cue_graph_timeline_copy`: copy a supported graph between standalone timeline files. The ID scan covers the target timeline only. Check the rest of the show for collisions before using the copy in a show. App acceptance remains unverified.
- `showkontrol_copy_cue_graph_node_show_copy`: copy a supported node into an existing cue graph in a new show copy. It copies no wires and rejects ID-like internal references. App acceptance remains unverified.
- `showkontrol_remove_cue_graph_node_copy`: remove an unreferenced node from an offline cue graph copy. The reference check is conservative and covers supported XML parts only. External references and app acceptance are not verified.
- `showkontrol_copy_cue_graphs_show_copy`: copy up to 100 supported cue graphs into one show copy. The destination filesystem must support hard links. App acceptance remains unverified.
- `showkontrol_inspect_show_timeline`, `showkontrol_add_show_timeline_cue_copy`: inspect a named `.sktl` part and add a simple cue in a new `.skshow` copy. The archive checksum must match. The tool validates part checksums and updates the changed part checksum. Other parts are preserved. ShowKontrol displayed a generated cue in a separate test session.
- `showkontrol_edit_timeline_cue_copy`, `showkontrol_delete_timeline_cue_copy`: edit or delete a cue in a new copy. Moving or editing a cue preserves its action graph. Deleting a cue with a graph requires `deleteGraph: true`. External references are not checked. App acceptance remains unverified.
- `showkontrol_edit_timeline_layer_copy`: append a copy of an existing layer or rename a layer in a new timeline or show copy. Layer deletion and reordering are not supported. App acceptance remains unverified.
- `showkontrol_create_show_track_copy`: add an empty track using an empty timeline in the same show as a template. The set list is unchanged. ShowKontrol R27 27.0.11 loaded a generated test show and displayed the new track in its catalog; playback and other track variants remain unverified.
- `showkontrol_inspect_show_setlist`, `showkontrol_add_show_setlist_track_copy`: inspect sets and append an existing track to a set in a new show copy. App acceptance remains unverified.
- `showkontrol_edit_show_setlist_copy`: create a set, remove a track entry, or change the order of track entries in a new show copy. App acceptance remains unverified. Set removal and set ordering are not supported.
- `showkontrol_inspect_patch`, `showkontrol_edit_patch_setting_copy`: inspect a version 2 `.skf` patch or `.skshow` file and change an existing application or node setting in a new copy. Inspection supplies the required source SHA-256. The setting value must be a string; the tool does not validate whether ShowKontrol accepts it. It does not create settings.
- `showkontrol_edit_patch_graph_copy`: duplicate or remove an existing node, or add or remove a connection, in a new offline patch copy. Supply the SHA-256 from `showkontrol_inspect_patch`. The tool checks node IDs and connection references. Remove a node's connections before you remove the node. A duplicate keeps the original title, settings, position, and unknown XML fields; review its settings and any internal references. The tool does not validate node or pin compatibility, input occupancy, or acceptance by ShowKontrol. It cannot create a node from a type definition. These graph edits have not been verified in ShowKontrol.
- `showkontrol_copy_patch_node`: copy a node from an inspected offline `.skf` or `.skshow` template into a new copy of another inspected patch. Supply both source checksums and a new, unused node ID. This copies the node XML only. Connections and external dependencies are not copied. The title, position, settings, and internal references stay unchanged, so names and references can collide. Hardware and node compatibility and acceptance by ShowKontrol are not validated. This operation has not been verified in ShowKontrol.
- `showkontrol_inspect_xml`, `showkontrol_edit_xml_copy`: inspect UTF-8 XML and make exact text edits in a new file. The source checksum must match.
- `showkontrol_inspect_show`, `showkontrol_read_show_part`, `showkontrol_edit_show_part_copy`: inspect the XML wrapper and its base64 parts, verify MD5 checksums, and edit one XML part in a new `.skshow` file. Untouched parts remain byte-for-byte unchanged.
- `showkontrol_inspect_show_overview`: summarize the parts, tracks, cues, set lists, and patch nodes from one show snapshot without returning raw XML.
- `showkontrol_validate_show`: check checksums, node IDs, graph connections, and set-track references. Check the per-part coverage and diagnostic severity: scene schema validation is incomplete and is reported as a warning. This does not check pin compatibility or prove the show will load or run.
- `showkontrol_read_show_part_page`: read a large UTF-8 show part in bounded pages. Pass the returned `sha256` and `nextOffset` to read the next page from the same source version. Offsets count UTF-16 code units.
- `showkontrol_create_marker_csv`: create a REAPER marker/region CSV for manual import into the Cue Editor. It writes a new file only. Times are rounded to milliseconds. Marker and region import has not been verified in ShowKontrol; the file does not contain action graphs.
- `showkontrol_create_rpp`: create a new `.rpp` file with markers, empty cue items, and audio or video media items. It does not overwrite an existing file. Import it with Cue Editor > REAPER > Import. Choose the target layers and check the import preview before you commit it. The item and media generators have not been verified in ShowKontrol.

### Media project input

Use `mediaTracks` in the `showkontrol_create_rpp` arguments. Each track has a `name`, a `kind` of `audio` or `video`, and an `items` array. Each item has a `file` path, `seconds`, and `duration`. Optional item fields are `name`, `sourceOffset`, `fadeIn`, `fadeOut`, and `takeVolume`. Times are seconds. Take volume is a linear multiplier: `1` is unity and `0.5` is approximately −6 dB. Fades are linear. The optional track `nativeColor` is a REAPER native colour integer, including its custom-colour flag. Native colour byte order depends on the computer that created the project.

Audio files must use `.wav`, `.mp3`, or `.flac`. Video items use REAPER's `VIDEO` source type. The generator does not check media existence, media duration, codecs, or whether the destination Mac can read a path. Use paths that exist on that Mac, or paths relative to the RPP file. Place the media where ShowKontrol can find it. The import dialog can still list missing media. The file only references media; it does not copy or embed it.

The generated files have passed structural tests and an independent RPP parser. Neither REAPER nor ShowKontrol has been used to verify the generated media items. Check the import preview, target lane, offsets, fades, and level before use. ShowKontrol's manual describes audio-lane import with source offset, length, fades, and take volume. It describes video-lane import, but does not promise that all audio-item properties also apply to video.

REST calls are not retried. After a timeout, read the show state before you decide whether to repeat a write. A timeout can occur after ShowKontrol applied a change. Binary reads and event samples are bounded as described above. Live API availability and the exact patch-building request schemas depend on the app and configuration. This bridge does not validate the semantics of generic requests.

Neither the RPP nor the marker CSV contains cue action graphs. It does not create a ShowKontrol track, import itself, or save a show. It cannot provide full show authoring. The installed app produced a `.skshow` XML wrapper with base64 parts and MD5 checksums. A modified copy passes checksum and XML checks. The complete show schema and automatic cue-graph authoring are not verified. Use test copies and check them in ShowKontrol before use.

## Test

Run `npm test`. Tests use a local mock HTTP server and temporary files. They do not change a live show. A passing mock test does not establish compatibility with the running app. On ShowKontrol R27 27.0.11, local pairing was used to validate a one-node patch dry run, preview a node, create/read/delete a temporary group node, and dry-run/create/read/delete a connection between two temporary groups. The temporary nodes and connection were removed. These checks used a separate test show with no connected players. Other node types, actions, cue imports, and file changes have not been verified in the app.

References: [Remote Control & API](https://manual.showkontrol.com/manual/remote), [Cue Editor & Timelines](https://manual.showkontrol.com/manual/timeline), and [REAPER state chunk definitions](https://github.com/ReaTeam/Doc/blob/master/State%20Chunk%20Definitions).

A generated test `.skshow` was opened in ShowKontrol. Its working `session.skf` matched the edited patch part byte-for-byte except that the app changed the root name to the session name. Semantic setting changes have not yet been verified through the app.
