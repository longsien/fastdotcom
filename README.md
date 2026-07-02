# fast

CLI tool to test your internet speed using fast.com (Netflix).

<p align="center">
  <img src="https://raw.githubusercontent.com/longsien/fastdotcom/main/docs/demo.gif"
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
fast                 # run a full speed test
fast --no-upload     # skip the upload test
fast --json          # print results as JSON
fast --duration 10   # measure each direction for 10s (3-30, default ~6)
fast --no-tui        # plain line output (auto when piped or NO_COLOR is set)
fast --version       # print the version
fast --help          # all options
```

## License

[MIT](LICENSE) © Long Sien
