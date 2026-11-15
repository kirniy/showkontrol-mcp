# Tools

The server provides 120 tools and one prompt. This page lists them by task. Each group links to its section of the [reference](reference.md), which has the arguments, checks, results and evidence.

## Discover tools from the client

- **Tool list.** In Claude Code, `/mcp` shows the server status and its tools. In Codex, `/mcp` lists configured MCP tools, and `/mcp verbose` adds details. You can also ask the agent to list the `showkontrol_` tools.
- **Schemas.** The MCP tool schemas from `tools/list` define the accepted arguments. Ask the agent to read a tool's schema before its first call. When this documentation and a schema differ, the schema is correct.
- **Annotations.** Tools marked `live read` or `read` below carry `readOnlyHint: true`. `new copy` tools carry `readOnlyHint: false` and `destructiveHint: false`. `live write` and `deletes` tools carry `destructiveHint: true`. Clients can use these hints for approval prompts; they are hints, not a safety guarantee.
- **Server instructions.** The server sends short usage rules when the client connects: inspect first, use the returned SHA-256, write to new copies, and do not retry live writes.
- **Prompt.** Clients that support MCP prompts can discover `author_offline_show` with `prompts/list`. Supply `showPath` and `goal` to `prompts/get`. The prompt guides the agent to inspect the source and donor material, select supported copy tools, and inspect and validate the result. It does not read or change a show by itself. Client support for displaying or invoking prompts varies; you can also ask an agent to follow the same steps directly using the tools below.
- **Live actions.** The app's own action catalogue is separate from the MCP tools. Use `showkontrol_search_actions` and `showkontrol_get_action` to find an action, then `showkontrol_run_action`.

## Effects

- `live read`: reads the running ShowKontrol. A dry run counts as a read.
- `live write`: can change the running show and control equipment.
- `read`: reads local files only.
- `new copy`: writes a new file or directory. It does not change the source or replace an existing destination.
- `deletes`: removes files. Only `showkontrol_remove_stale_session_staging` does this, and only for staging directories it verifies as stale.

## Live API

[Reference](reference.md#live-api)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_discover` | live read | State, status, nodes, node types, settings, variables or the patch |
| `showkontrol_read` | live read | Any JSON or text GET endpoint under `/api/v1` |
| `showkontrol_read_binary` | live read | A binary endpoint as base64, up to 5 MiB |
| `showkontrol_sample_events` | live read | Sample the event stream for up to 30 s and 100 events |
| `showkontrol_get_plays` | live read | Play history from `/data/plays` |
| `showkontrol_get_insights` | live read | `/data/insights` as returned |
| `showkontrol_get_deck` | live read | Deck detail; frame data may be stale |
| `showkontrol_get_live_deck` | live read | Live transport state of one deck from `/state` |
| `showkontrol_diagnose_live_node` | live read | Compare a node's `node.stopped` with its effective `stopped` |
| `showkontrol_list_actions` | live read | List the action catalogue |
| `showkontrol_search_actions` | live read | Filter the action catalogue by category and text |
| `showkontrol_get_action` | live read | Metadata for one action ID |
| `showkontrol_node_type_detail` | live read | Pins and parameters of a node type |
| `showkontrol_validate_node_settings` | live read | Check planned values against node-type metadata |
| `showkontrol_get_parameter` | live read | Read one node parameter |
| `showkontrol_list_connections` | live read | Read the running patch connections |
| `showkontrol_verify_live_connections` | live read | Compare expected wires with live connections |
| `showkontrol_get_patch` | live read | Read the whole running patch |
| `showkontrol_validate_patch` | live read | Dry-run a patch specification |
| `showkontrol_plan_live_graph` | live read | Dry-run planned nodes and connections and resolve final titles |
| `showkontrol_write` | live write | Any POST, PUT, PATCH or DELETE endpoint |
| `showkontrol_deck_command` | live write | Send a transport command to a deck |
| `showkontrol_run_action` | live write | Run an action catalogue ID |
| `showkontrol_session_command` | live write | Launch the show or switch a screen |
| `showkontrol_set_node_bypass` | live write | Set `node.bypassed` by node ID and read it back |
| `showkontrol_set_parameter_verified` | live write | Set one parameter and read it back |
| `showkontrol_set_parameter` | live write | Set a node parameter |
| `showkontrol_set_setting` | live write | Set an application setting |
| `showkontrol_fire_node` | live write | Fire a node |
| `showkontrol_create_node` | live write | Preview or create a node; `dryRun` is required |
| `showkontrol_delete_node` | live write | Delete a node |
| `showkontrol_create_connection` | live write | Preview or create a connection; `dryRun` is required |
| `showkontrol_delete_connection` | live write | Delete a connection |
| `showkontrol_put_patch` | live write | Submit a whole patch |
| `showkontrol_compose_live_patch` | live write | Submit a typed patch plan; `dryRun` defaults to `true` |
| `showkontrol_create_staged_live_graph` | live write | Create nodes one by one, then connect them by returned ID |

## Show files and parts

[Reference](reference.md#show-files-and-parts)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_inspect_show_overview` | read | Summarize parts, tracks, cues, set lists, patch nodes and Program items |
| `showkontrol_validate_show` | read | Check checksums, IDs, connections, references and cue fields (partial coverage) |
| `showkontrol_inspect_show` | read | Read the wrapper manifest and verify part MD5 checksums |
| `showkontrol_read_show_part` | read | Read one UTF-8 part |
| `showkontrol_read_show_part_page` | read | Read a large part in bounded pages |
| `showkontrol_edit_show_part_copy` | new copy | Edit one XML part |
| `showkontrol_inspect_xml` | read | Read a UTF-8 XML file and its SHA-256 |
| `showkontrol_edit_xml_copy` | new copy | Exact text replacements in an XML file |

## Timelines and cues

[Reference](reference.md#timelines-and-cues)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_inspect_timeline` | read | Inspect a standalone `.sktl` |
| `showkontrol_inspect_show_timeline` | read | Inspect a timeline part of a show |
| `showkontrol_add_timeline_cue_copy` | new copy | Add a simple cue to a `.sktl` |
| `showkontrol_add_show_timeline_cue_copy` | new copy | Add a simple cue to a show timeline |
| `showkontrol_add_show_timeline_cues_copy` | new copy | Add up to 100 cues across timelines |
| `showkontrol_edit_show_timeline_cues_copy` | new copy | Edit up to 100 cue fields across timelines |
| `showkontrol_edit_timeline_cue_copy` | new copy | Edit one cue and keep its graph |
| `showkontrol_delete_timeline_cue_copy` | new copy | Delete one cue |
| `showkontrol_edit_timeline_layer_copy` | new copy | Append, rename, move or remove an empty layer |
| `showkontrol_inspect_cue_references` | read | Find literal references to a cue and its node IDs |

## Audio lanes and clips

[Reference](reference.md#audio-lanes-and-clips)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_add_timeline_audio_lane_copy` | new copy | Add an empty audio lane |
| `showkontrol_add_timeline_audio_clip_copy` | new copy | Add a clip to a lane |
| `showkontrol_edit_timeline_audio_clip_copy` | new copy | Edit existing clip attributes, including `file` |
| `showkontrol_remove_timeline_audio_clip_copy` | new copy | Remove one clip |
| `showkontrol_remove_timeline_audio_lane_copy` | new copy | Remove one lane |
| `showkontrol_rename_timeline_audio_lane_copy` | new copy | Rename one lane |
| `showkontrol_move_timeline_audio_lane_copy` | new copy | Move a lane; the first lane never moves |

## Cue graphs

[Reference](reference.md#cue-graphs)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_inspect_cue_graph` | read | Nodes, connections and settings of a cue graph |
| `showkontrol_copy_cue_graph_show_copy` | new copy | Copy a graph to an empty cue, from the same or another show |
| `showkontrol_copy_cue_graphs_show_copy` | new copy | Copy up to 100 graphs |
| `showkontrol_copy_cue_graph_timeline_copy` | new copy | Copy a graph between standalone timelines |
| `showkontrol_copy_cue_graph_node_show_copy` | new copy | Copy one node into an existing graph |
| `showkontrol_copy_patch_node_to_cue_show_copy` | new copy | Copy a patch node into a cue graph |
| `showkontrol_copy_patch_setting_to_cue_show_copy` | new copy | Copy one patch-node setting to a matching cue node |
| `showkontrol_assemble_cue_graph_show_copy` | new copy | Assemble nodes and pin-0 wires from template shows |
| `showkontrol_assemble_mixed_cue_graph_show_copy` | new copy | Assemble nodes from cue graphs and patches |
| `showkontrol_edit_cue_graph_setting_copy` | new copy | Change one existing node setting |
| `showkontrol_edit_cue_graph_settings_show_copy` | new copy | Change up to 100 existing settings |
| `showkontrol_add_cue_graph_setting_copy` | new copy | Add a missing supported setting |
| `showkontrol_set_cue_graph_node_stopped_copy` | new copy | Set a node's stored stopped state |
| `showkontrol_edit_cue_graph_wire_copy` | new copy | Add or remove a pin-0 connection |
| `showkontrol_remove_cue_graph_node_copy` | new copy | Remove an unreferenced node |
| `showkontrol_remove_cue_graph_copy` | new copy | Remove a cue's graph and keep the cue |

## Tracks and set lists

[Reference](reference.md#tracks-and-set-lists)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_create_show_track_copy` | new copy | Add an empty track from a template |
| `showkontrol_clone_media_track_copy` | new copy | Clone a media-backed timeline, with or without its cues |
| `showkontrol_rename_show_track_copy` | new copy | Rename a track and its set-list entries |
| `showkontrol_remove_show_track_copy` | new copy | Remove a timeline part |
| `showkontrol_inspect_show_setlist` | read | Inspect sets |
| `showkontrol_create_show_setlist_copy` | new copy | Create a set list with one set |
| `showkontrol_add_show_setlist_track_copy` | new copy | Append a track to a set |
| `showkontrol_edit_show_setlist_copy` | new copy | Create, remove or move sets; remove or move entries |

## Composition

[Reference](reference.md#composition)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_compose_show_copy` | new copy | Create or edit one track with cues, graphs, layers, audio and a set entry |
| `showkontrol_compose_multi_track_show_copy` | new copy | Up to 20 tracks, patch operations and set-list operations |
| `showkontrol_compose_full_show_copy` | new copy | Patch, tracks, set lists and a Program in one transaction |

## Patch files

[Reference](reference.md#patch-files)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_inspect_patch` | read | Nodes, connections and settings of a `.skf` or show patch |
| `showkontrol_edit_patch_setting_copy` | new copy | Change one existing setting |
| `showkontrol_edit_patch_graph_copy` | new copy | Duplicate or remove a node; add or remove a connection |
| `showkontrol_edit_patch_batch_copy` | new copy | Up to 100 ordered patch operations |
| `showkontrol_copy_patch_node` | new copy | Copy a node from another patch |

## Programs

[Reference](reference.md#programs)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_inspect_program` | read | Items of a standalone `.skpr` |
| `showkontrol_inspect_show_program` | read | The Program part of a show |
| `showkontrol_inspect_program_item_graph` | read | One item's graph |
| `showkontrol_inspect_program_timeline` | read | One item's embedded timeline |
| `showkontrol_compose_program_schedule_copy` | new copy | Create an ordered Program in a show |
| `showkontrol_compose_program_edits_copy` | new copy | Ordered edits to an existing Program, its graphs and item timelines |
| `showkontrol_create_program_copy` | new copy | Create a `.skpr`, or add, edit or remove one item |
| `showkontrol_extract_show_program_copy` | new copy | Extract a show's Program to a `.skpr` |
| `showkontrol_attach_show_program_copy` | new copy | Attach a `.skpr` to a show |
| `showkontrol_extract_program_timeline_copy` | new copy | Extract an item timeline to a `.sktl` |
| `showkontrol_embed_program_timeline_copy` | new copy | Embed a timeline in an item |
| `showkontrol_embed_remapped_program_timeline_copy` | new copy | Embed a timeline with fresh node IDs |
| `showkontrol_copy_program_item_graph_copy` | new copy | Copy a cue graph into an item |
| `showkontrol_copy_remapped_program_item_graph_copy` | new copy | Copy a cue graph into an item with fresh node IDs |
| `showkontrol_remap_program_item_graph_copy` | new copy | Give an item graph fresh node IDs |
| `showkontrol_edit_program_item_graph_setting_copy` | new copy | Change one item graph setting |

## Media and sessions

[Reference](reference.md#media-and-sessions)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_inspect_show_media` | read | `media.map` rows, media parts, timeline media fields and clips of a show |
| `showkontrol_add_media_mappings_copy` | new copy | Add `media.map` rows, or create the part |
| `showkontrol_edit_media_mappings_copy` | new copy | Remove or re-point `media.map` rows |
| `showkontrol_inspect_session_media` | read | Lanes, clips, mappings and sidecar status of a session directory |
| `showkontrol_preflight_session_audio` | read | Readability and ffprobe duration of the media behind each clip |
| `showkontrol_compose_session_media_copy` | new copy | New session directory with media, tracks, patch, set lists and Program |
| `showkontrol_find_session_staging` | read | Find staging directories left by killed calls |
| `showkontrol_remove_stale_session_staging` | deletes | Remove staging directories verified as stale |

## REAPER and marker files

[Reference](reference.md#reaper-and-marker-files)

| Tool | Effect | Purpose |
| --- | --- | --- |
| `showkontrol_preflight_rpp_media` | read | Check media paths and durations for an intended RPP |
| `showkontrol_create_rpp` | new copy | Create a REAPER project for manual Cue Editor import |
| `showkontrol_create_marker_csv` | new copy | Create a marker and region CSV for manual import |
