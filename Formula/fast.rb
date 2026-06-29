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
  homepage "https://github.com/longsien/fastdotcom"
  url "https://registry.npmjs.org/fastdotcom/-/fastdotcom-1.0.0.tgz"
  sha256 "9d0fe1921d806e0a5162a383d5f3c5973aab7da0f519c6a1693eb2db6c8fc8f3"
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
