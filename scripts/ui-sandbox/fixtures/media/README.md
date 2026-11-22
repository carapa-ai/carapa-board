# Media fixtures

`fixture-video.mp4` and `fixture-video.WEBM` are synthetic: they contain only ffmpeg's built-in `testsrc` pattern, no third-party footage. Regenerate them with:

```bash
ffmpeg -y -f lavfi -i testsrc=duration=1.5:size=320x240:rate=15 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart fixture-video.mp4
ffmpeg -y -f lavfi -i testsrc=duration=1.5:size=320x240:rate=15 \
  -c:v libvpx -b:v 200k fixture-video.WEBM
```

Do not add recordings of other products or people to this folder.
