# vhs tape for the README demo.
#   Regenerate with:  vhs docs/demo.tape   (run from the repo root)
# Requires: vhs, ttyd, ffmpeg  (brew install vhs)

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 820
Set Height 400
Set Padding 24
Set Framerate 24
Set PlaybackSpeed 1.0

# Make `fast` resolve to the local script without a global install, off-camera.
Hide
Type "alias fast='node index.js'"
Enter
Type "clear"
Enter
Show

Type "fast"
Sleep 600ms
Enter

# A full run: discovery → ping → ~6s download → ~6.5s upload, then the summary.
Sleep 22s

# Hold the final frame so the loop lingers on the result.
Sleep 2s
