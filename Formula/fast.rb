# Homebrew formula for `fast`.
#
# This installs the published npm package `fastdotcom`, which provides the
# `fast` command. Distribute it from your own tap so users can:
#
#     brew install longsien/tap/fast
#
# To set the tap up (one time):
#     1. Create a GitHub repo named `homebrew-tap` under your account.
#     2. Copy this file to `Formula/fast.rb` in that repo.
#
# After each `npm publish`, bump `url` to the new version and refresh `sha256`:
#     curl -sL https://registry.npmjs.org/fastdotcom/-/fastdotcom-<version>.tgz | shasum -a 256
#
class Fast < Formula
  desc "Tiny zero-dependency CLI speedtest using fast.com (Netflix) with a live TUI"
  homepage "https://github.com/longsien/fast"
  url "https://registry.npmjs.org/fastdotcom/-/fastdotcom-0.1.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256" # see the curl one-liner above
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "fast.com", shell_output("#{bin}/fast --help")
  end
end
