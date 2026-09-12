<#
.SYNOPSIS
Installs or verifies installation of a Minecraft Bedrock .mcaddon or .mcpack on Windows.

.DESCRIPTION
Extracts behavior and resource packs from a .mcaddon or .mcpack archive into the
Windows Bedrock shared pack directory:
  %APPDATA%\Minecraft Bedrock\Users\Shared\games\com.mojang\{behavior_packs,resource_packs}

Defaults to dry-run verification. Pass -Install to extract pack files to disk.

.PARAMETER PackPath
Path to the .mcaddon or .mcpack file. Defaults to latest add-on found in web/public/downloads or build/.

.PARAMETER Install
Switch to perform actual file extraction. When omitted, performs dry-run verification.
#>
param(
  [string]$PackPath,
  [switch]$Install
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent

if (-not $PackPath) {
  $searchDirs = @(
    (Join-Path $projectRoot 'web\public\downloads'),
    (Join-Path $projectRoot 'output\current-qa'),
    (Join-Path $projectRoot 'build')
  )
  foreach ($dir in $searchDirs) {
    if (Test-Path $dir) {
      $found = Get-ChildItem -Path $dir -Filter '*.mcaddon' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
      if ($found) {
        $PackPath = ($found | Select-Object -First 1).FullName
        break
      }
    }
  }
  if (-not $PackPath) {
    throw "No PackPath provided and no .mcaddon found in standard project directories."
  }
}

if (-not (Test-Path -LiteralPath $PackPath)) {
  throw "Pack archive not found at: $PackPath"
}

$bedrockRoot = Join-Path $env:APPDATA 'Minecraft Bedrock\Users\Shared\games\com.mojang'
if (-not (Test-Path -LiteralPath $bedrockRoot)) {
  # Fallback to local appdata packages path if shared games path is absent
  $packagesRoot = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang'
  if (Test-Path -LiteralPath $packagesRoot) {
    $bedrockRoot = $packagesRoot
  } else {
    throw "Current Windows Bedrock pack directory was not found (checked shared and UWP packages paths)."
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($PackPath)
try {
  $jobs = foreach ($entry in $archive.Entries) {
    if ($entry.FullName.EndsWith('/')) { continue }
    # Recognize pack folders: *_BP, *_RP, behavior_packs, resource_packs
    $kind = $null
    $packDirName = $null
    $relative = $null

    if ($entry.FullName -match '^([^/\\]+_(?:BP|RP))[/\\](.+)$') {
      $packFolder = $Matches[1]
      $relative = $Matches[2]
      $kind = if ($packFolder -match '_BP$') { 'behavior_packs' } else { 'resource_packs' }
      $packDirName = $packFolder
    } elseif ($entry.FullName -match '^(behavior_packs|resource_packs)[/\\]([^/\\]+)[/\\](.+)$') {
      $kind = $Matches[1]
      $packDirName = $Matches[2]
      $relative = $Matches[3]
    } else {
      # Single-pack archive (e.g. root manifest.json)
      $kind = 'behavior_packs'
      $packDirName = [IO.Path]::GetFileNameWithoutExtension($PackPath)
      $relative = $entry.FullName
    }

    if ($relative.Split('/\\') -contains '..' -or $relative.Contains(':')) {
      throw "Invalid archive relative path: $relative"
    }

    $destinationRoot = [IO.Path]::GetFullPath((Join-Path $bedrockRoot "$kind\$packDirName"))
    $destination = [IO.Path]::GetFullPath((Join-Path $destinationRoot $relative))
    if (-not $destination.StartsWith($destinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Archive path escaped destination: $destination"
    }

    [PSCustomObject]@{
      Entry = $entry
      Destination = $destination
      Kind = $kind
      Pack = $packDirName
    }
  }

  if ($Install) {
    foreach ($job in $jobs) {
      $parent = Split-Path $job.Destination -Parent
      if (-not (Test-Path -LiteralPath $parent)) {
        [IO.Directory]::CreateDirectory($parent) | Out-Null
      }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($job.Entry, $job.Destination, $true)
    }
  }

  [PSCustomObject]@{
    Installed = [bool]$Install
    Files = @($jobs).Count
    Root = $bedrockRoot
    Pack = $PackPath
    Note = if ($Install) { 'Files extracted. Host world must enable the behavior/resource pack.' } else { 'Dry run passed. Pass -Install to extract files.' }
  } | ConvertTo-Json
} finally {
  $archive.Dispose()
}
