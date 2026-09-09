# Rate Your Flow

[Website](https://rate-your-flow.vercel.app) · [27-second demo](https://github.com/ram4-dev/rate-your-flow/releases/download/v0.1.7/rate-your-flow-x.mp4)

https://github.com/user-attachments/assets/0af1ab58-a5ae-4b37-82d2-875ff8f0572d

`ryf` reviews recent AI coding-agent sessions and turns them into a local HTML
report. It reads Codex and Pi session files without modifying them.

The semantic pass uses the 50 sessions with the most recent activity in the
last 90 days. It combines that sample with local metrics from every session in
the window. The report states the sample size so a score is never presented as
full-history coverage.

## Install

The package is not on the npm registry. Install the release tarball instead:

```sh
npm install -g https://github.com/ram4-dev/rate-your-flow/releases/download/v0.1.7/rate-your-flow-0.1.7.tgz
ryf --version
```

Use Node.js 24.5 or newer.

## Run

```sh
ryf
```

The command finds local Codex and Pi sessions from the last 90 days, writes a
self-contained HTML report under `~/.ryf/reports/`, and prints both its path
and `file://` URL.

If no endpoint is configured, the report contains local metrics and an
"analysis incomplete" status. `ryf` makes no network request and does not
invent a total score.

To inspect exactly what an analysis service would receive, without sending
anything:

```sh
ryf --preview
```

Local parsing is read-only. Before a remote analysis, `ryf` shows the redacted,
bounded digest and asks for consent. The digest can include short redacted
snippets from messages and tool output. It is not a raw trace export.

No API key belongs in the CLI. A complete score needs an analysis endpoint.
Until a public endpoint exists, request access at [@ram4_dev](https://x.com/ram4_dev)
or [ramirocarnicersouble8@gmail.com](mailto:ramirocarnicersouble8@gmail.com).

## Configure an endpoint

For a one-off run, pass the backend base URL. Do not append `/analyze` because
the CLI adds that path itself.

```sh
ryf --endpoint https://your-ryf-service.example
```

The endpoint is remembered after consent. You can also create
`~/.config/ryf/config.json`:

```json
{
  "endpoint": "https://your-ryf-service.example"
}
```

For an internal service with its own CA, add a PEM file path:

```json
{
  "endpoint": "https://your-ryf-service.example",
  "caFile": "/absolute/path/to/service-ca.pem"
}
```

The client config accepts only `endpoint` and `caFile`; it never stores an API
key. See [self-hosting notes](docs/self-hosting.md) when you operate the
backend.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm run build
npm test
```

The installed-package end-to-end suite needs Redis:

```sh
RYF_TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:e2e
```

The landing and launch video have their own packages in `landing/` and
`video/`. Run their checks separately:

```sh
npm --prefix landing test
npm --prefix landing run build
npm --prefix video ci
npm --prefix video run lint
npm --prefix video run build
```

## License

[MIT](LICENSE)
