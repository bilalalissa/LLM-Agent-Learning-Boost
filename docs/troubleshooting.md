# Troubleshooting

## No Vaults Found

Check `VAULTS_ROOT` in your config file and confirm at least one folder has `.obsidian`, `AGENTS.md`, or a `*-vault` name.

## Local AI Unavailable

Open the Provider tab. For `local_auto`, check:

- Ollama is running and reachable.
- MLX-LM Server is running if configured.
- MLX-LM CLI is installed if configured.
- LAN endpoints are enabled only when intended.

Cloud fallback requires explicit confirmation.

## Ingest Creates No Cards

Run:

```bash
npm run learning:check
npm run check
```

Confirm the source is in `raw/`, the provider is available, and the source type is supported by local extractors.

## RemNote Export Requires Confirmation

Large exports are blocked until confirmed:

```bash
npm run learning:export-remnote -- --confirm-large
```

## Remote Research Does Not Run

Remote research asks before network access by default. Use the Chat tab controls or provide confirmation through the API. The fetcher blocks private hosts, credential URLs, and paywall/login-like paths unless explicitly directed with rights.

## macOS Build Fails

Run:

```bash
npm test
npm run check
./scripts/build_macos_app.sh
```

If Swift or signing errors appear, check the macOS toolchain and the native wrapper resources under `native/macos/`.
