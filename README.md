# fast

A tiny, **zero-dependency** CLI that measures your connection speed using
[fast.com](https://fast.com) (Netflix Open Connect) as its backend.

On a TTY it renders a small btop-style live TUI — each metric is a gauge that
fills as the test runs, with a soft shimmer sweeping the border while a
measurement is in flight. Piped or `--json` output falls back to plain text.

<p align="center">
  <img src="https://raw.githubusercontent.com/longsien/fast/main/docs/demo.gif"
       alt="fast running in a terminal: ping, then download and upload gauges filling live"
       width="760">
</p>

## Install

Run it once, without installing:

```sh
npx fastdotcom
```

Install globally from npm (the command is `fast`):

```sh
npm install -g fastdotcom
```

Or via Homebrew:

```sh
brew install longsien/tap/fast
```

> Requires **Node.js ≥ 18** (it uses the built-in global `fetch`). Homebrew
> pulls Node in as a dependency.

## Usage

```sh
fast                # live TUI: ping, download, upload
fast --no-upload    # skip the upload test
fast --json         # machine-readable output (implies plain text)
fast --no-tui       # force plain line output instead of the TUI
fast --help
```

### Options

| Option | Description |
| --- | --- |
| `--json` | Output results as JSON (implies plain output). |
| `--no-upload` | Skip the upload test. |
| `--no-tui` | Force plain line output instead of the TUI. |
| `-h`, `--help` | Show help. |

### Plain output

When stdout isn't a TTY (e.g. piped to a file), output is plain text:

```
Testing via fast.com Melbourne · AU
  latency  25.7 ms avg  (min 14.5 ms / max 92.7 ms)  jitter 9.5 ms
  download 480.7 Mbps  (avg 382.8 Mbps / max 707.5 Mbps)
  upload   118.3 Mbps  (avg 96.1 Mbps / max 142.0 Mbps)  (approx)
```

### JSON output

`--json` emits a single object. Speeds are in **bits per second**, latency in
**milliseconds**:

```jsonc
{
  "provider": "fast.com",
  "uploadProvider": "fast.com",
  "uploadApprox": true,
  "latencyMs": { "min": 14.5, "avg": 25.7, "max": 92.7, "p90": 41.2, "jitter": 9.5 },
  "downloadBps": { "min": 210400000, "avg": 382800000, "max": 707500000, "p90": 480700000 },
  "uploadBps":   { "min": 70100000, "avg": 96100000, "max": 142000000, "p90": 118300000 },
  "colo": "Melbourne",
  "city": "Melbourne",
  "country": "AU",
  "ip": "203.0.113.7"
}
```

## How it reads

Download and upload share **one scale** — the run's peak equals a full bar — so
the two gauges are directly comparable at a glance. Each bar is filled to its
**average**, with a bright tick at the **minimum** and superscript min / avg /
max labels below. Ping is shown as a single number with its spread and jitter.

The footer headlines each stream's **90th-percentile** throughput (near the
sustained peak, which is how speed tests usually report).

## How it works

[fast.com](https://fast.com) (Netflix Open Connect) is the sole backend. fast
scrapes the short-lived token from fast.com's JS bundle, asks the API for a
handful of CDN target URLs, then:

- **Download** — streams sized range requests in parallel across the targets,
  aggregating bytes into fixed time windows and discarding warm-up windows.
- **Latency** — times small requests over a reused connection; jitter is the
  median absolute deviation from the mean.
- **Upload** — a send-side raw-socket POST that credits bytes as the kernel
  drains them. Open Connect's ingest buffers are large, so this reads on the
  **high side** and is flagged approximate (shown with a `~` and `approx`).

Because the token and discovery endpoint are unofficial, they can change; any
failure surfaces as a normal error rather than a bogus reading.

## Development

Zero runtime dependencies. Tests use the built-in Node test runner:

```sh
npm test
```

Regenerate the demo GIF (requires [`vhs`](https://github.com/charmbracelet/vhs)
— `brew install vhs`):

```sh
vhs docs/demo.tape
```

## License

[MIT](LICENSE) © Long Sien
