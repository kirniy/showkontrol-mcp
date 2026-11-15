# ShowKontrol MCP bridge

A local Model Context Protocol (MCP) server for ShowKontrol R27. It gives compatible clients, such as Claude Code and Codex, access to the ShowKontrol REST API and tools for inspecting and editing supported offline show files. It can also generate REAPER projects for manual import.

This is an early bridge. It does not cover the complete show format or prove that an edited show will load or run. Live commands can change a show and control equipment. Work on copies, inspect results, and test them in ShowKontrol before use. See [Evidence and limits](docs/evidence.md) for what has been observed in ShowKontrol.

## What it does

- **Live API.** Inspect state, nodes, parameters, connections, decks, actions and events. Plan, dry-run, apply and read back patch changes.
- **Offline shows.** Inspect and validate `.skshow`, `.sktl`, `.skf` and `.skpr` files. Write new copies with tracks, cues, layers, cue graphs, patch edits, set lists and Programs, one change at a time or in one composed transaction.
- **Audio and sessions.** Add, edit, remove, rename and move audio lanes and clips. Edit `media.map` rows. Compose a saved session directory with new media copied into `MEDIA/`, and check the media behind each clip.
- **REAPER.** Create `.rpp` projects and marker CSV files for manual import in the Cue Editor, after a media preflight.

Offline write tools create new copies. They never change their source and do not replace an existing destination. The one exception, `showkontrol_remove_stale_session_staging`, deletes only staging directories that it verifies as stale.

## Quick start

1. Install Node.js 20 or later, then run `npm ci` in this directory.
2. In ShowKontrol R27, enable local plugin pairing. Offline tools need no ShowKontrol connection.
3. Register the server. Replace both paths with absolute paths on your computer (`command -v node` prints the first one).

   Claude Code:

   ```sh
   claude mcp add --scope user --transport stdio showkontrol -e SHOWKONTROL_USE_LOCAL_PAIRING=1 -- "/absolute/path/to/node" "/absolute/path/to/showkontrol-mcp/server.js"
   ```

   Codex CLI:

   ```sh
   codex mcp add --env SHOWKONTROL_USE_LOCAL_PAIRING=1 showkontrol -- "/absolute/path/to/node" "/absolute/path/to/showkontrol-mcp/server.js"
   ```

4. Restart the client and ask it to call `showkontrol_discover` with `status`. For offline work, ask it to run `showkontrol_inspect_show_overview` on a show file.

Network connections, tokens, other clients, environment variables, smaller toolsets and atomic session publication are covered in [Setup](docs/setup.md).

## Documentation

| Page | Use it to |
| --- | --- |
| [Setup](docs/setup.md) | Install, register with Claude Code, Codex or another client, connect to ShowKontrol, enable atomic session publication |
| [Workflow](docs/workflow.md) | Follow an end-to-end example: inspect, compose a show copy, add session media, validate, test in ShowKontrol |
| [Tools](docs/tools.md) | Find a tool by task and see whether it reads, writes a copy or changes the live show |
| [Reference](docs/reference.md) | Look up a tool's arguments, checks, results and limits |
| [Evidence and limits](docs/evidence.md) | See what was observed in ShowKontrol, what is unsupported and which evidence is missing |
| [Contributing](CONTRIBUTING.md) | Develop and test changes |

The server's MCP tool schemas are the source of the accepted arguments.

## Safety rules

- A successful API response does not prove that an action had its intended effect. Check the relevant live state.
- REST calls are not retried; after a timeout, inspect state before repeating a write.
- Validation has partial coverage. Report which checks you ran, and test the result in ShowKontrol before relying on it.
- Keep tokens in the client's private environment. Never commit a token.

## Test

Run `npm test`. The suite uses mock servers and temporary files; it does not change a live show. Mock tests do not prove compatibility with ShowKontrol. To include the optional app-reserialized audio timeline test, set `SHOWKONTROL_AUDIO_FIXTURE` to the path of a suitable `.sktl` file. An invalid path fails the test.

`docs.test.js` checks the documentation: relative links and heading anchors resolve, and the [tool index](docs/tools.md) matches the tools and annotations the server registers.

## References

- [ShowKontrol Remote Control & API](https://manual.showkontrol.com/manual/remote)
- [ShowKontrol Cue Editor & Timelines](https://manual.showkontrol.com/manual/timeline)
- [REAPER state chunk definitions](https://github.com/ReaTeam/Doc/blob/master/State%20Chunk%20Definitions)
