$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ManifestPath = Join-Path $RootDir "CSXS/manifest.xml"
$DistDir = Join-Path $RootDir "dist"
$BuildRoot = Join-Path $RootDir ".msi-build"
$StageRoot = Join-Path $BuildRoot "stage"
$StageExtDir = Join-Path $StageRoot "Veo-Bridge"
$ObjDir = Join-Path $BuildRoot "obj"

if (!(Test-Path $ManifestPath)) {
    throw "manifest not found: $ManifestPath"
}

function Get-ManifestAttr([string]$Path, [string]$Attr) {
    [xml]$xml = Get-Content -Path $Path -Raw
    $node = $xml.ExtensionManifest
    if ($null -eq $node) { return "" }
    $value = $node.GetAttribute($Attr)
    if ([string]::IsNullOrWhiteSpace($value)) { return "" }
    return $value
}

function Normalize-MsiVersion([string]$VersionText) {
    $clean = [Regex]::Replace($VersionText, "[^0-9.]", "")
    if ([string]::IsNullOrWhiteSpace($clean)) { return "0.1.0" }
    $parts = $clean.Split(".", [System.StringSplitOptions]::RemoveEmptyEntries)
    $a = 0; $b = 1; $c = 0
    if ($parts.Length -ge 1) { [int]::TryParse($parts[0], [ref]$a) | Out-Null }
    if ($parts.Length -ge 2) { [int]::TryParse($parts[1], [ref]$b) | Out-Null }
    if ($parts.Length -ge 3) { [int]::TryParse($parts[2], [ref]$c) | Out-Null }
    if ($a -lt 0) { $a = 0 }
    if ($b -lt 0) { $b = 0 }
    if ($c -lt 0) { $c = 0 }
    if ($a -gt 255) { $a = 255 }
    if ($b -gt 255) { $b = 255 }
    if ($c -gt 65535) { $c = 65535 }
    return "$a.$b.$c"
}

function Require-Tool([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (!$cmd) {
        throw "$Name not found. Install WiX Toolset v3 and ensure $Name is in PATH."
    }
    return $cmd.Source
}

$bundleVersion = Get-ManifestAttr -Path $ManifestPath -Attr "ExtensionBundleVersion"
if ([string]::IsNullOrWhiteSpace($bundleVersion)) { $bundleVersion = "0.1.0" }
$msiVersion = Normalize-MsiVersion $bundleVersion

$productName = "Veo Bridge"
$manufacturer = "Veo Bridge"
$upgradeCode = "{A1D40F91-5A03-4974-A66E-B7B7C241C03F}"
$msiPath = Join-Path $DistDir ("Veo-Bridge-" + $bundleVersion + ".msi")

$heatExe = Require-Tool "heat.exe"
$candleExe = Require-Tool "candle.exe"
$lightExe = Require-Tool "light.exe"

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
if (Test-Path $BuildRoot) {
    Remove-Item -Recurse -Force -Path $BuildRoot
}
New-Item -ItemType Directory -Force -Path $StageExtDir | Out-Null
New-Item -ItemType Directory -Force -Path $ObjDir | Out-Null

$requiredPaths = @("CSXS", "css", "js", "jsx", "index.html", "gallery.html")
foreach ($rel in $requiredPaths) {
    $src = Join-Path $RootDir $rel
    if (!(Test-Path $src)) {
        throw "Missing required path: $rel"
    }
    $dst = Join-Path $StageExtDir $rel
    Copy-Item -Path $src -Destination $dst -Recurse -Force
}

$mainWxsPath = Join-Path $BuildRoot "Product.wxs"
$harvestWxsPath = Join-Path $BuildRoot "VeoBridgeFiles.wxs"

@"
<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product
      Id="*"
      Name="$productName"
      Language="1033"
      Version="$msiVersion"
      Manufacturer="$manufacturer"
      UpgradeCode="$upgradeCode">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perUser" InstallPrivileges="limited" />
    <MediaTemplate EmbedCab="yes" />
    <MajorUpgrade DowngradeErrorMessage="A newer version of $productName is already installed." />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="AppDataFolder">
        <Directory Id="AdobeDir" Name="Adobe">
          <Directory Id="CEPDir" Name="CEP">
            <Directory Id="ExtensionsDir" Name="extensions">
              <Directory Id="INSTALLDIR" Name="Veo-Bridge" />
            </Directory>
          </Directory>
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="MainFeature" Title="$productName" Level="1">
      <ComponentGroupRef Id="VeoBridgeFiles" />
    </Feature>
  </Product>
</Wix>
"@ | Set-Content -Path $mainWxsPath -Encoding UTF8

& $heatExe dir $StageExtDir `
    -nologo `
    -cg VeoBridgeFiles `
    -dr INSTALLDIR `
    -scom `
    -sreg `
    -sfrag `
    -srd `
    -gg `
    -var var.StageDir `
    -out $harvestWxsPath
if ($LASTEXITCODE -ne 0) { throw "heat.exe failed" }

$objOutPrefix = Join-Path $ObjDir ""
& $candleExe -nologo -dStageDir="$StageExtDir" -out $objOutPrefix $mainWxsPath $harvestWxsPath
if ($LASTEXITCODE -ne 0) { throw "candle.exe failed" }

$mainWixObj = Join-Path $ObjDir "Product.wixobj"
$harvestWixObj = Join-Path $ObjDir "VeoBridgeFiles.wixobj"
if (!(Test-Path $mainWixObj) -or !(Test-Path $harvestWixObj)) {
    throw "Expected wixobj files were not generated."
}

if (Test-Path $msiPath) {
    Remove-Item -Force -Path $msiPath
}
# Per-user install into AppData triggers standard ICE checks (ICE38/ICE64/ICE91).
# They are safe for this extension layout and are suppressed to allow CI packaging.
& $lightExe -nologo -sice:ICE38 -sice:ICE64 -sice:ICE91 -out $msiPath $mainWixObj $harvestWixObj
if ($LASTEXITCODE -ne 0) { throw "light.exe failed" }

if (Test-Path $BuildRoot) {
    Remove-Item -Recurse -Force -Path $BuildRoot
}

Write-Host "Build complete: $msiPath"
