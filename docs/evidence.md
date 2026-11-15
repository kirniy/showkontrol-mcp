# Evidence and limits

This page says what has been observed in ShowKontrol, what has only been tested with mocks and synthetic files, and what the bridge does not support. Per-tool limits stay with each tool in the [reference](reference.md); this page collects them so they are easy to find.

The tools support some offline edits, not full show authoring. Validation has partial coverage and does not prove that a show will load or run. Test the resulting copy in ShowKontrol and report the checks performed.

## Levels of evidence

The documentation uses these levels. Report the level you actually reached.

- **Observed in ShowKontrol.** A recorded test in ShowKontrol R27 (27.0.11 unless stated otherwise). Each one covers the specific case tested, usually in a disposable test show with no connected players.
- **MCP test.** The tool ran through MCP against a real app-saved file or a live test session, and its output was read back. The app did not necessarily open the result.
- **Mock and synthetic tests.** `npm test` uses mock HTTP servers and synthetic files. These tests check the bridge's own behavior; they do not show compatibility with ShowKontrol.
- **Static evidence.** Formats inferred from app-saved files, the R27 manual or static inspection of R27 code.
- **Unverified.** Nothing above covers it. Most offline write paths are unverified in the app.

No result here establishes full ShowKontrol compatibility, playback through connected equipment or hardware output.

## Not supported

The bridge does not do the following. Each item links to the details.

- **Full show authoring.** The complete show schema is not known. Offline tools change supported structures and keep everything else byte-for-byte. See [Show files and parts](reference.md#show-files-and-parts).
- **Proof that a show loads or runs.** `showkontrol_validate_show` has partial coverage. It does not check pin compatibility, loading, playback or execution.
- **Offline node creation from `/nodes/types`.** Offline tools only copy or duplicate nodes that ShowKontrol saved. See [Offline node creation](#offline-node-creation).
- **Media authoring in plain show files.** Track, timeline and Program tools do not copy media, add `media.map` rows or create waveform caches. `showkontrol_add_media_mappings_copy` adds rows only. Use [`showkontrol_compose_session_media_copy`](reference.md#session-directories) for a session directory.
- **Trim checks against media length.** Session preflight reports trims and durations but does not compare them. See [Clip trims and media duration](#clip-trims-and-media-duration).
- **Some lane changes.** The first audio lane never moves. Renames to or from `Audio 1` are refused. Lanes with unknown attributes or content are refused. See [Audio lane names and order](#audio-lane-names-and-order).
- **Automatic REAPER import.** RPP and marker CSV files have no action graphs. You import them by hand in the Cue Editor. See [REAPER and marker files](reference.md#reaper-and-marker-files).
- **Retries and rollback for live writes.** REST calls are not retried. `showkontrol_create_staged_live_graph` stops at the first failure and does not roll back. An HTTP success does not prove the intended effect.
- **Request body schemas for every action.** Action metadata names do not necessarily match POST fields. See [Actions, transport and generic writes](reference.md#actions-transport-and-generic-writes).
- **Detection of external, computed, encoded or binary references.** Reference checks find literal text in supported XML parts only. Some checks are conservative and can reject harmless text.

## Observed in ShowKontrol

These results were recorded in ShowKontrol R27 27.0.11. Each covers only the case described.

Offline files:

- A cue added with `showkontrol_add_timeline_cue_copy` loaded and was displayed at 5 seconds with a 2-second duration. A cue added to a show part was also displayed.
- A track added with `showkontrol_create_show_track_copy` was displayed in the catalog.
- A composed archive from `showkontrol_compose_show_copy` opened in a fresh session. The app displayed the track, its two cues and its set-list position.
- A generated cue graph with a saved notification action executed during playback. The event arrived about 8.3 seconds after the recorded pre-play state, consistent with a cue at 8 seconds.
- A generated RPP imported two WAV items and two cue items. After save, the timeline recorded the requested positions, source trims and fades. Take volume was not verified.
- Opening a generated `.skshow` wrote a working `session.skf` equal to `patch.skf` except for the root name.

Live API:

- Patch dry run, node preview, node create/read/delete and connection create/delete on temporary groups in a test show.
- `showkontrol_compose_live_patch` applied nodes and a pin 0 connection, and the readback matched. `showkontrol_create_staged_live_graph` created and connected same-titled nodes by ID.
- `showkontrol_set_node_bypass` and the bypass actions changed and restored `node.bypassed` on a disconnected group.
- Action listing, action metadata, `app.screen.cueeditor`, plays and insights returned responses through MCP.
- A configured notification action fired manually and its notification appeared on the event stream.

Negative and unexplained results:

- A generated routing cue did not switch the router during playback.
- Later notification cues produced no observed notification. A positive control on the same stream did.
- A timer trigger connected to an action did not fire during an automatic run.
- An OSC generator produced no observed packet at a loopback receiver.
- Several nodes reported effectively stopped while their stop parameters were false. The cause is unknown.

The full record is in [Live test record](#live-test-record).

Session publication:

- On the owner's Mac with Node.js 26.8.1 and `--experimental-ffi` (owner-reported, 15 November 2026), the publication test reported `renamex_np_excl` in a temporary directory. That is the only execution of the native binding. The Linux `renameat2` binding through `node:ffi` has not been executed. See [Atomic session publication](setup.md#atomic-session-publication).

## Not observed in ShowKontrol

The app has not opened or run the output of these tool groups. The reference describes the MCP tests and static evidence for each.

- Generated session directories, including `media.map` rows, sidecars and working files.
- `media.map` rows added, created, removed or re-pointed in a show copy.
- Added, edited, removed, renamed or moved audio lanes and clips.
- Generated or edited Programs, item ordering, item graphs and Program item media.
- Set lists created or edited by the set-list tools, layer operations, track removal and rename, multi-track and full-show compositions, and media-backed clones.
- Offline patch setting and graph edits.
- Most copied, assembled or edited cue graphs. Only the notification graphs described above executed.

## Live test record

Tests use a local mock HTTP server and temporary files. They do not change a live show. A passing mock test does not establish compatibility with the running app. On ShowKontrol R27 27.0.11, local pairing was used to validate a one-node patch dry run, preview a node, create/read/delete a temporary group node, and dry-run/create/read/delete a connection between two temporary groups. The temporary nodes and connection were removed. These checks used a separate test show with no connected players. Other node types, actions, cue imports, and file changes remain unverified except as described below.

In a separate live test, a temporary action node was configured for a local web notification, fired, and deleted. The matching notification appeared in the MCP event stream. A second test saved an action node with non-default notification settings and then deleted it. These tests checked the patch action independently of a timeline cue.

A live MCP test also created a temporary group and changed its `node.description` through `app.node.param` using `appact.node` (the group title), `appact.key`, and `appact.value`. A second test created a configured action node for the same operation, fired it, and read back the changed description. The action reported effectively stopped despite a false `node.stopped` parameter; manual firing still produced the observed change. Both tests removed their temporary nodes and restored the node and connection baseline. This does not establish automatic graph or cue execution. A separate live test connected a timer trigger to the same action. Manual action controls worked before and after the test, but the timer fire count stayed at zero and the target value did not change during the automatic run. Both trigger and action reported effectively stopped while their stop parameters were false; the reason is unknown. The test nodes were removed and the patch baseline was restored.

ShowKontrol opened a generated test archive containing a cue graph with that saved notification node. Its catalog displayed the track with three cues. With no external players connected, the internal player loaded a synthetic audio file whose title matched the track; audio output was disabled. During playback, the MCP event stream received the cue's notification. A repeat produced a new event about 8.3 seconds after the recorded pre-play state, consistent with the cue at 8 seconds. Player settings were restored after both runs. This verifies that specific generated trigger-and-notification graph; other action types, media import, and connected equipment remain unverified. In a separate test, a generated routing cue did not switch the router when the live player state passed its 8-second position. In a fresh test session, a save at 8.26 seconds recorded the three cue graph nodes as stopped. The cause and whether that saved state reflects cue execution are not known. In a later comparison run, the notification cue produced no observed notification even though its saved nodes were not stopped. A later notification test started at zero and crossed the cue while playing. A positive control notification appeared on the same event stream, but the cue notification did not. The saved cue graph nodes were stopped; their active in-memory state was not established. These tests do not establish why either cue failed. The MCP live-deck tool was also tested during playback and returned the advancing position from `/state`.

## Open evidence gaps

Each gap lists the missing evidence and a capture that would close it.

### Offline node creation

No offline tool creates a patch or cue graph node from a `/nodes/types` definition. Offline tools duplicate or copy nodes that ShowKontrol saved. The live type definitions and the saved XML are different formats, and the repository has no recorded pair that links them.

- Live API: `showkontrol_node_type_detail` returns `request`, `type`, and `params` entries with `key`, `kind`, `value`, and optional `options`, `min`, and `max`. Values are JSON. The only recorded response is a partial R27 trigger response with `boolean`, `text`, `integer`, `enum`, and `color` kinds. A live node read reports a top-level `stopped` value that can differ from its `node.stopped` parameter.

- Saved XML: a node is `<node id type x y title layer kind>`, sometimes with `stopped="1"`, and contains `<settings>` with text `<setting key>` values. R27-saved fixtures contain `groupin`, `trigger`, and `action` nodes with an empty `kind`, a Script `processor` with an empty `kind` and a `proc.mode` setting, and an OSC `generator` with `kind="OSC"`. Their values include `true`, `false`, decimal integers, and enum labels.

The following evidence is missing:

1. The mapping from `request` to the saved `type` and `kind`. No recorded saved node has a known creation request. For example, the Script request string and the saved type of a live `group` node are not recorded.
2. The settings the app writes. The saved `cue_active` trigger omits `node.bypassed`, `node.description`, and `trigger.release_ms`, which the recorded trigger type lists with values. The saved Script processor stores six settings, including `proc.background` set to `false`. Whether default values are omitted, or depend on the creation request, is unknown.
3. The text form of `number` and `color` values.
4. The title rule. The app derives titles such as `cue_active` and `FeedbackNotify` from settings.
5. The values of `x`, `y`, `layer`, and `kind` for a new node, and whether each is required.
6. When `stopped="1"` is written, and how it relates to `node.stopped` and the live `stopped` value.
7. Dependent parameters, such as `action.t7` after `action.category`, and how live pin names map to the numeric pins in saved connections.
8. App acceptance of any node that ShowKontrol did not save itself.

To add a node offline now, create it in a test show with `showkontrol_create_node` or `showkontrol_compose_live_patch` (dry run first), save the show in ShowKontrol, inspect the saved file, and use it as a donor. Use `showkontrol_copy_patch_node`, the `duplicate_node` operation of `showkontrol_edit_patch_graph_copy`, or `showkontrol_copy_patch_node_to_cue_show_copy`, then change existing settings with the setting tools. To support creation, record from one app version, for each request: the full type response, the `POST /nodes` request and response, and the `patch.skf` the app saves afterwards. Record one node with all parameters unchanged and one with a changed parameter of each kind.

### Clip trims and media duration

`showkontrol_preflight_session_audio` reports trims and durations side by side but does not compare them, because the available evidence does not establish what the clip trim attributes mean. The evidence is limited to the following:

- The attribute names `trimStartMs` and `trimEndMs`. A name suggests milliseconds but does not establish the unit, or whether `trimEndMs` is a source position, a length, or an amount removed from the end.

- One app save that reserialized a synthetic clip with these attributes. Its source path was empty, so no media length was involved.

- The R27 27.0.11 session that the app saved after the REAPER import test described in [REAPER and marker files](reference.md#media-project-input). It holds two clips imported from WAV files of known length, four seconds each, with byte-identical copies in its `MEDIA` folder. It is the only app-saved observation that pairs clip trims with media of known length. The app saved "the requested positions, source trims, and fades", but this repository does not record the stored `trimStartMs` and `trimEndMs` values or the `SOFFS` and `LENGTH` that requested them, and the session is not in the repository.

  Even with those values, this one observation would not establish the general semantics. It covers one format, one import path and two clips. It does not show what the app stores when a trim is edited in the app, or what it allows at or beyond the end of the media. Where a clip starts at the beginning of its source, a `trimEndMs` source position and a length are the same number, so that clip cannot tell them apart.

- The add and edit tools here require `trimEndMs` to exceed `trimStartMs` and treat the difference as the clip length for fade checks. That is a convention of these tools, not app evidence.

To close the gap, first record the stored `offsetMs`, `trimStartMs` and `trimEndMs` of both clips in the existing session next to the RPP items that produced them. Then run this capture in R27 and keep the files:

1. Use a PCM WAV with an exact sample count, such as 10.000 s at 48 kHz, so its length does not depend on a decoder.
2. With `showkontrol_create_rpp`, create two items on one track: `sourceOffset: 2.5, duration: 4`, and `sourceOffset: 0, duration: 10`. Import, save, and record `offsetMs`, `trimStartMs` and `trimEndMs` for both clips.
3. In the app, drag a clip's end to the end of the media, then try to drag it past the end. Save after each step and record the values, and whether the app stops at the end of the media.

If the first clip stores 2500 and 6500, the trims are source positions in milliseconds; 2500 and 4000 would be a start and a length; 2500 and 3500 would be amounts removed from each end. An exceed check could then be added for that case only. The check would also need to show whether the app's media length matches the ffprobe container duration for compressed formats such as MP3, which can contain encoder delay and padding. Until then, use `showkontrol_preflight_rpp_media` before a REAPER import. There `sourceOffset + duration` is compared in REAPER's documented seconds.

### Audio lane names and order

No app-saved file available here holds more than one audio lane. The only lane the app has been seen to write is the R27 27.0.11 empty track's `<audio name="Audio 1" follow="0"/>`. Its meaning for `follow` is not established. The R27 manual (Cue Editor & Timelines, manual.showkontrol.com) does give lane names and order meaning. The rename and move tools are built around these statements:

- Order. With Play Whole Track for Decks, the Mac plays a Catalog track's whole arrangement, "Audio 1 (the song) included". The player's waveform sits on the first audio lane as a read-only clip, and the Catalog and Set List show it as the track's preview. Transition rehearsal plays "each track's main audio (its first audio clip)". A Program item plays all its lanes, "there is no deck here playing lane 1". So the first lane matters, and the move tool never changes which lane is first, in tracks or Program items. The manual does not say whether the song is found by position or by the name `Audio 1`.

- Names. With Replace Target Layers, a REAPER import empties the layers and lanes it writes to, and "Layers and lanes are found again by name"; an empty default lane (`Audio 1`) is reused before new lanes are added. Renaming a lane therefore changes which lane a later import targets. Renaming to or from `Audio 1` is refused, because the default lane's identity may depend on that name.

- Unknown fields. Each lane has its own Output Device and channel pair, and video lanes, marked V1, V2, sit with the audio lanes. The saved form of either has not been observed. A lane with attributes other than `name` and `follow`, or with content other than clips, may therefore be a video lane or carry output settings. Moves and renames refuse it rather than guess.

- References. Lanes have no IDs. Anything that might address a lane by position or name blocks the change: literal names for renames, and fields that mention audio, lane or video for moves. The check is a keyword heuristic over supported XML parts. It does not see computed references, set lists, carried TIMELINE/ working files, REAPER projects or app settings.

Unverified: whether the app keeps a moved or renamed lane's output, DECK state and clips; whether lane order beyond the first lane changes playback, engine grouping, REAPER export order or the editor view; and app acceptance of the copies. To close the gap, save a disposable R27 track with three lanes in the app. Give them distinct names, output pairs and DECK states, and put one clip in each. Record the bytes. Then drag lane 3 above lane 2, save again and compare. Repeat with a rename, a video lane, and a REAPER import using Replace Target Layers.
