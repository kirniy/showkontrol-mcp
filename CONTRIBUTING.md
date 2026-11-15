# Contributing

Use Node.js 20 or later. Install the locked dependencies with `npm ci`, then run `npm test`. The suite uses Node's test runner, temporary files, and mock HTTP servers. It does not test a live ShowKontrol session.

For changes to an offline writer, test the output and failure cases. Check that the source stays unchanged and that a failed operation does not publish a destination. Use synthetic fixtures unless you have permission to share real show data.

For live API changes, use a separate test show without connected equipment. Record the ShowKontrol version, operation, observed result, and any limits. Do not describe mock results as live verification. Remove temporary objects and verify the baseline after a live test.

Do not commit credentials, pairing keys, private shows, media, or play data. Keep tokens in the client environment. When a format or behavior is not verified, say so in the documentation.

The optional audio timeline test accepts `SHOWKONTROL_AUDIO_FIXTURE` as an absolute path to an app-reserialized `.sktl` file with a direct audio clip that has a `vol` attribute. The test skips when the variable is absent. It fails if the supplied file cannot be read or does not meet those conditions.
