$ErrorActionPreference = 'Stop'
$auditionDir = $PSScriptRoot
$repoRoot = Resolve-Path -LiteralPath (Join-Path $auditionDir '..\..\..')
$voices = (Get-Content -LiteralPath (Join-Path $auditionDir 'voices.json') -Raw -Encoding UTF8 | ConvertFrom-Json).voices

Push-Location -LiteralPath $repoRoot
try {
  foreach ($voice in $voices) {
    $destination = Join-Path $auditionDir "$($voice.slug).mp3"
    if (Test-Path -LiteralPath $destination) {
      Write-Output "[$($voice.slug)] already exists; preserving"
      continue
    }
    Write-Output "[$($voice.slug)] generating"
    & pnpm cli tts --provider gemini-tts --voice $voice.voiceId --gemini-key-index "$($voice.keyIndex)" --text-file (Join-Path $auditionDir 'audition-script.txt') --output $destination
    if ($LASTEXITCODE -eq 2) {
      Write-Output "[$($voice.slug)] generated for review; see its verification report"
    } elseif ($LASTEXITCODE -ne 0) {
      throw "Generation stopped for $($voice.slug); rerun this script to resume after the error is resolved."
    }
  }
} finally {
  Pop-Location
}
