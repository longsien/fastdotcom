# fast

Check your internet speed from the terminal. `fast` measures your ping,
download, and upload using [fast.com](https://fast.com) (Netflix) and shows it
all on a live, animated display.

<p align="center">
  <img src="https://raw.githubusercontent.com/longsien/fast/main/docs/demo.gif"
       alt="fast running in a terminal: ping, then download and upload gauges filling live"
       width="760">
</p>

## Install

Run it once, no install needed:

```sh
npx fastdotcom
```

Or install it for good:

```sh
npm install -g fastdotcom      # then run: fast
brew install longsien/tap/fast
```

## Usage

```sh
fast              # run a full speed test
fast --no-upload  # skip the upload test
fast --json       # print results as JSON
fast --help       # all options
```

That's it. No account, no config, no tracking.

## License

[MIT](LICENSE) © Long Sien
