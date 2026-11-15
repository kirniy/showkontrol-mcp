# Contributing

Use Node.js 20 or later. Install the locked dependencies with `npm ci`, then run `npm test`. The suite uses Node's test runner, temporary files, and mock HTTP servers. It does not test a live ShowKontrol session.

For changes to an offline writer, test the output and failure cases. Check that the source stays unchanged and that a failed operation does not publish a destination. Use synthetic fixtures unless you have permission to share real show data.

For live API changes, use a separate test show without connected equipment. Record the ShowKontrol version, operation, observed result, and any limits. Do not describe mock results as live verification. Remove temporary objects and verify the baseline after a live test.

Do not commit credentials, pairing keys, private shows, media, or play data. Keep tokens in the client environment. When a format or behavior is not verified, say so in the documentation.

The optional audio timeline test accepts `SHOWKONTROL_AUDIO_FIXTURE` as the path to an app-reserialized `.sktl` file with a direct audio clip that has a `vol` attribute. The test skips when the variable is absent. It fails if the supplied file cannot be read or does not meet those conditions.

## Documentation

Keep each fact in one place and link to it:

- [README](README.md): overview, quick start and the documentation map.
- [Setup](docs/setup.md): installation, client registration, environment variables and runtime options.
- [Workflow](docs/workflow.md): task walkthroughs. Link to the reference instead of repeating tool details.
- [Tools](docs/tools.md): one row per tool with its effect. Add a row when you add a tool.
- [Reference](docs/reference.md): arguments, checks, results and limits of each tool, in the section for its task.
- [Evidence and limits](docs/evidence.md): app observations, unsupported behavior and open evidence gaps.

`node --test docs.test.js` checks relative links, heading anchors, and that the tool index matches the registered tools and their annotations. State the evidence level of every new claim, as in [Evidence and limits](docs/evidence.md#levels-of-evidence).
