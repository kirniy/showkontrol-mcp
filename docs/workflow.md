# Workflow

This page walks through a realistic show-authoring session. It names the tools to call and the results to check, so you can ask Claude Code or Codex to follow it step by step. Argument details are in the [reference](reference.md). The MCP tool schemas define the accepted arguments.

## Working rules

- **Work on copies.** Offline write tools never change the source. Each writes a new destination that must not exist yet.
- **Chain hashes.** Inspect a file and pass its `sha256` to the next write. Every write returns the new file's SHA-256. Use that value, or inspect the new copy again, before the next edit. A stale hash fails the call.
- **Inspect after every write.** Read the result back with the matching inspect tool before you build on it.
- **Validate, then test in ShowKontrol.** `showkontrol_validate_show` has partial coverage. A clean result does not prove that the show loads, plays or runs. Open the copy in ShowKontrol before you rely on it.
- **Report the evidence level.** Say which checks ran: MCP inspection, validation, or a test in ShowKontrol. See [Evidence and limits](evidence.md).
- **Treat live writes as real.** Live tools can change the running show and control equipment. Use a separate test show without connected equipment while you develop a change. After a timeout, read the state before repeating a write.

## Example: add an opening track to a show

Goal: add a track called `Opening` with two cues, reuse a cue graph from a donor show, put the track in a set list, schedule it in the Program, and then attach an intro audio file in the saved session.

The argument shapes below were run through MCP against synthetic test files on 15 November 2026. ShowKontrol did not open the results.

### 1. Inspect the source and donors

Ask the client:

> Inspect `/Shows/Club.skshow` with `showkontrol_inspect_show_overview` and `showkontrol_validate_show`. List its timelines, set lists and Program items. Then inspect the cue graph of cue `c1` in `content/Donor.sktl` of `/Shows/Donor.skshow`.

Tools: `showkontrol_inspect_show_overview`, `showkontrol_validate_show`, `showkontrol_inspect_show_timeline`, `showkontrol_inspect_cue_graph`.

Check:

- The overview `sha256` of each show. The compose call needs the source hash and the donor hash.
- The empty template timeline to build the track from. The R27 empty track has four layers and one audio lane, `Audio 1`.
- Existing validation errors and warnings in the source. Do not mistake them for errors you introduced later.
- The donor graph's nodes, settings and stored stopped state.

### 2. Compose the show copy

Use one `showkontrol_compose_full_show_copy` call, so every stage publishes together or not at all:

```json
{
  "source": "/Shows/Club.skshow",
  "destination": "/Shows/Club-v2.skshow",
  "sha256": "<overview sha256 of Club.skshow>",
  "tracks": [{
    "templateName": "content/Empty.sktl",
    "trackName": "Opening",
    "partName": "content/Opening.sktl",
    "cues": [
      {"layer": 0, "startMs": 0, "lengthMs": 2000, "label": "Intro"},
      {"layer": 1, "startMs": 8000, "lengthMs": 1000, "label": "Drop",
       "donor": {"file": "/Shows/Donor.skshow", "sha256": "<donor sha256>",
                 "name": "content/Donor.sktl", "cueId": "c1"}}
    ]
  }],
  "setlistOperations": [
    {"operation": "create_setlist", "name": "content/Setlist.skls", "setName": "Main", "tracks": ["Opening"]}
  ],
  "program": {"items": [
    {"start": 79200000, "name": "Doors", "notes": "", "timeline": {"stagedShow": {"trackIndex": 0}, "remapCueIds": true}}
  ]}
}
```

`create_setlist` applies only when the show has no set-list part; otherwise use `append_track`. Program `start` is local milliseconds since midnight, so `79200000` is 22:00. `stagedShow: {trackIndex: 0}` embeds the track created in the same call.

Check in the result:

- `tracks` gives the new cue IDs and the node ID mapping of the copied graph.
- `program` gives the item ID mappings.
- `warnings`, for example `stored_stopped_cue_node` for a copied node saved as stopped.
- `validation` describes the final copy. Look at errors, warnings and per-part `coverage`, not only the absence of errors.

Then inspect `Club-v2.skshow` again with `showkontrol_inspect_show_overview`, `showkontrol_inspect_show_setlist` and `showkontrol_inspect_show_program`.

### 3. Add media in a saved session

`.skshow` copies do not carry media. A saved session directory does: `session.skshow`, `media.map` and a `MEDIA/` folder. Use the session tools for audio files.

1. `showkontrol_inspect_session_media` with the session `directory`. Keep its `showSha256`. Read `lanes`, `clips` and their `mapping`, and `unmappedMediaEntries`.
2. `showkontrol_preflight_session_audio` with the same `directory` and `sha256`. It reports whether each clip's sidecar and source path can be read, and ffprobe durations. It does not compare trims with durations.
3. `showkontrol_compose_session_media_copy` to write a new session directory:

```json
{
  "source": "/Sessions/Club",
  "destination": "/Sessions/Club v2",
  "sha256": "<showSha256 from showkontrol_inspect_session_media>",
  "media": [{"source": "/Media/intro.wav"}],
  "tracks": [{
    "existingPartName": "content/Opening.sktl",
    "audioClips": [{"audioIndex": 0, "mediaIndex": 0, "clip": {
      "name": "Intro", "wave": "", "grid": "", "pps": "100", "offsetMs": "0",
      "trimStartMs": "0", "trimEndMs": "1000", "fadeInMs": "0", "fadeOutMs": "0"}}]
  }]
}
```

`mediaIndex: 0` selects the first `media` entry and writes its source path as the clip `file`. The clip fields follow one R27 imported-WAV clip. `trimEndMs` must exceed `trimStartMs`; the meaning of the trim fields is not established (see [Clip trims and media duration](evidence.md#clip-trims-and-media-duration)).

Check in the result:

- `mediaMap` and `sidecars`: the new row and the byte-verified `MEDIA/` copy with its SHA-256.
- `clipLinks`: each new clip with its `media.map` line.
- `publication`: `renamex_np_excl` or `renameat2_noreplace`, or `claim_rename` with a `fallbackReason`. See [Atomic session publication](setup.md#atomic-session-publication).
- `workingFiles` and `warnings`: how each working file was carried over.
- `validation` for the composed `session.skshow`.

Then run `showkontrol_inspect_session_media` and `showkontrol_preflight_session_audio` on the new directory. If an earlier call was killed, run `showkontrol_find_session_staging` on the parent directory, then `showkontrol_remove_stale_session_staging` for entries it reports as `stale`.

The same call accepts `patchOperations`, `setlistOperations` and `program`, so steps 2 and 3 can run as one session composition.

### 4. Test in ShowKontrol

Open the new session in ShowKontrol on a computer without connected equipment, or with outputs disabled. Check the track, cues, set list, Program item, clip position and audio. Record the version and what you saw. Until then, report the result as MCP-inspected and validated only.

## Other workflows

### Prepare a REAPER import

1. `showkontrol_preflight_rpp_media` with the intended `.rpp` path and `mediaTracks`. Set `probeDurations: true` to check `sourceOffset + duration` against ffprobe durations.
2. `showkontrol_create_rpp`, or `showkontrol_create_marker_csv` for markers only.
3. In ShowKontrol, open Cue Editor > REAPER > Import. Choose the target layers and check the import preview before you commit it.

See [REAPER and marker files](reference.md#reaper-and-marker-files).

### Edit a Program item timeline

Extract, edit and embed again: `showkontrol_extract_show_program_copy`, `showkontrol_extract_program_timeline_copy`, the timeline tools, `showkontrol_embed_program_timeline_copy`, then `showkontrol_attach_show_program_copy`. Or apply ordered edits in one call with `showkontrol_compose_program_edits_copy`. See [Edit a schedule step by step](reference.md#edit-a-schedule-step-by-step).

### Add a node to a show offline

Offline tools cannot create a node from a type definition. Create it in a test show with the live tools, save the show in ShowKontrol and use the saved file as a donor. See [Offline node creation](evidence.md#offline-node-creation).

### Build a live patch graph

1. `showkontrol_discover` with `status` and `nodes` to check the connection and the current patch.
2. `showkontrol_node_type_detail` for each node request, then `showkontrol_validate_node_settings` for the planned values.
3. `showkontrol_plan_live_graph` to dry-run nodes and connections. Read each preview's `paramComparison`: the app can accept a value and return a different one.
4. Apply with `showkontrol_compose_live_patch` and `dryRun: false`, or with `showkontrol_create_staged_live_graph` to create nodes one by one and connect them by returned ID.
5. Read the result back with `showkontrol_verify_live_connections` and `showkontrol_get_parameter`, or use `showkontrol_set_parameter_verified` for single values.

These steps verify accepted writes, not graph execution. See [Live API](reference.md#live-api).

## The `author_offline_show` prompt

Clients that support MCP prompts can use `author_offline_show` with `showPath` and `goal`. It asks the agent to follow the offline steps above: inspect, map the change to supported copy tools, write to new destinations, then inspect, validate and report the checks performed. See [Tool discovery](tools.md#discover-tools-from-the-client).
