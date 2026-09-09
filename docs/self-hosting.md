# Self-hosting Rate Your Flow

The CLI does not use a client API key. The backend holds the provider
credential and accepts a redacted digest only after the CLI user gives consent.

Build the project, then run the backend with its required environment values.
Use a secret manager to inject `OPENCODE_GO_API_KEY`; do not write it into a
client config file or commit it. The command below assumes that credential is
already present in the process environment.

```sh
npm run build
RYF_COUNTER_MODE=redis \
RYF_REDIS_URL=redis://127.0.0.1:6379 \
RYF_KEY_PREFIX=ryf \
RYF_PROVIDER_ENDPOINT=https://provider.example/v1 \
RYF_PROVIDER_MODEL=your-model \
portless ryf-analysis node dist/backend/main.js
```

`RYF_COUNTER_MODE` must be `redis` or `dev-memory`. Redis also requires
`RYF_REDIS_URL` and `RYF_KEY_PREFIX`. The backend listens on loopback port
`8787` by default. Set `PORT` and `RYF_BIND_HOST` only when your deployment
requires them.

Put the service behind TLS and configure the CLI with the base URL. The CLI
posts to `<base-url>/analyze`, so do not save a URL that already ends in
`/analyze`.

```json
{
  "endpoint": "https://your-ryf-service.example"
}
```

For a private CA, add `caFile` with an absolute path to its PEM certificate.
The config schema rejects extra keys and never accepts credentials.
