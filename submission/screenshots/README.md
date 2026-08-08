# Submission screenshots

`capture.mjs` runs each command **for real**, writes its combined stdout+stderr to
`out/<name>.txt`, and renders that same text to `out/<name>.png` in a terminal-styled
page via Playwright. Nothing is hand-typed transcript — several shots are failing
commands, captured as they failed, because they are the bug evidence.

```bash
node capture.mjs        # all shots
node capture.mjs 05     # just the ones starting "05"
```

Needs `agent/.env` (`T3N_API_KEY` + `DID`); the key is redacted from every capture
before it is written. Playwright comes from `../demo-web/node_modules` via a
directory junction — recreate it with:

```powershell
New-Item -ItemType Junction -Path node_modules -Target ..\demo-web\node_modules
```

The live shots (01, 04–08) spend testnet credits; the read-only CLI shots do not.

Index of what each screenshot shows: see
[`../SUPERTEAM_SUBMISSION.md`](../SUPERTEAM_SUBMISSION.md) §7.
