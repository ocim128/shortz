# Generates the fixture matrix (see docs/technical/project-structure.md).
# Requires ffmpeg + ffprobe on PATH. Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File fixtures/make-fixtures.ps1
$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot ''

Write-Host '[fixtures] landscape_1080p_10s.mp4 (16:9 + stereo tone)'
# Static bars keep the file small; motion would inflate the repo.
& ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "smptehdbars=size=1920x1080:rate=30:duration=10" `
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=10" `
  -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p `
  -c:a aac -b:a 128k -ac 2 -shortest (Join-Path $out 'landscape_1080p_10s.mp4')

Write-Host '[fixtures] landscape_vfr.mp4 (variable frame rate)'
& ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=4" `
  -vf "setpts='if(lt(N,60),N/(30*TB),(2+(N-60)/15)/TB)'" -fps_mode vfr `
  -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p `
  (Join-Path $out 'landscape_vfr.mp4')

Write-Host '[fixtures] portrait_rotated.mp4 (coded 1920x1080 + rotate=90)'
$plain = Join-Path $env:TEMP 'shortz_plain_rot.mp4'
& ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=3" `
  -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=3" `
  -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p `
  -c:a aac -b:a 128k -ac 2 -shortest $plain
& ffmpeg -y -hide_banner -loglevel error -display_rotation 90 -i $plain -c copy (Join-Path $out 'portrait_rotated.mp4')
Remove-Item -Force $plain -ErrorAction SilentlyContinue

Write-Host '[fixtures] square_4x3.avi (no audio)'
& ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "smptehdbars=size=640x480:rate=25:duration=3" `
  -c:v mpeg4 -q:v 4 (Join-Path $out 'square_4x3.avi')

Write-Host '[fixtures] surround_5_1.mp4 (5.1 audio)'
& ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=3" `
  -f lavfi -i "anullsrc=channel_layout=5.1:sample_rate=48000" -t 3 `
  -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p `
  -c:a aac -b:a 256k (Join-Path $out 'surround_5_1.mp4')

Write-Host '[fixtures] tiny_2s.mp4 (edge duration)'
& ffmpeg -y -hide_banner -loglevel error `
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=2" `
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=2" `
  -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p `
  -c:a aac -b:a 128k -ac 2 -shortest (Join-Path $out 'tiny_2s.mp4')

Write-Host '[fixtures] done'
Get-ChildItem $out -Include *.mp4, *.avi | Select-Object Name, Length
