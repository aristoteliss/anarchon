# The README demo. Record it from the repository root with VHS (https://github.com/charmbracelet/vhs):
#   vhs assets/quick-start.tape
# For a video to share, change the Output line to assets/quick-start.mp4.
Output assets/quick-start.gif

# Visual Settings
Set FontSize 16
Set FontFamily "JetBrains Mono"
Set Width 920
Set Height 520
Set Padding 24
Set WindowBar Colorful
Set WindowBarSize 40
Set Theme "Catppuccin Mocha"

# Three processes, a graceful stop, then a crash: examples/quick-start.ts takes about 23 s.
Type "npx tsx examples/quick-start.ts"
Sleep 800ms
Enter

Sleep 27s
