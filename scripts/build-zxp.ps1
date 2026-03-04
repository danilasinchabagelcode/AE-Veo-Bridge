$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ManifestPath = Join-Path $RootDir "CSXS/manifest.xml"
$ConfigPath = Join-Path $RootDir ".zxp-build.env"
$DistDir = Join-Path $RootDir "dist"
$StageDir = Join-Path $RootDir ".zxp-stage"

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

function Safe-Name([string]$Value) {
    return ([Regex]::Replace($Value, "[^A-Za-z0-9._-]", "-"))
}

function Read-Config([string]$Path) {
    $result = @{}
    if (!(Test-Path $Path)) { return $result }
    $lines = Get-Content -Path $Path
    foreach ($line in $lines) {
        if ($line -match '^\s*#') { continue }
        if ($line -notmatch '=') { continue }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $line.Substring(0, $idx).Trim()
        $val = $line.Substring($idx + 1).Trim()
        if ($key.Length -gt 0) {
            $result[$key] = $val
        }
    }
    return $result
}

$bundleVersion = Get-ManifestAttr -Path $ManifestPath -Attr "ExtensionBundleVersion"
$bundleId = Get-ManifestAttr -Path $ManifestPath -Attr "ExtensionBundleId"
if ([string]::IsNullOrWhiteSpace($bundleVersion)) { $bundleVersion = "0.0.0" }
if ([string]::IsNullOrWhiteSpace($bundleId)) { $bundleId = "com.veobridge.bundle" }
$bundleIdSafe = Safe-Name $bundleId
$zxpName = "$bundleIdSafe-$bundleVersion.zxp"

if (!(Test-Path $ConfigPath)) {
    $zxDefault = ""
    $cmd = Get-Command ZXPSignCMD -ErrorAction SilentlyContinue
    if ($cmd) { $zxDefault = $cmd.Source }
    @"
# Auto-generated on first run.
# Paths can contain spaces. No quotes needed.
ZXPSIGN_CMD=$zxDefault
CERT_PATH=$RootDir/.certs/VeoBridgeCert.p12
CERT_PASSWORD=
CERT_COUNTRY=US
CERT_STATE=NA
CERT_COMMON_NAME=Veo Bridge Dev
CERT_ORG=Veo Bridge
CERT_ORG_UNIT=Extensions
"@ | Set-Content -Path $ConfigPath -Encoding UTF8
    Write-Host "Created config: $ConfigPath"
}

$config = Read-Config -Path $ConfigPath
$zx = $config["ZXPSIGN_CMD"]
$certPath = $config["CERT_PATH"]
$certPassword = $config["CERT_PASSWORD"]
$certCountry = $config["CERT_COUNTRY"]
$certState = $config["CERT_STATE"]
$certCommonName = $config["CERT_COMMON_NAME"]
$certOrg = $config["CERT_ORG"]
$certOrgUnit = $config["CERT_ORG_UNIT"]

if ([string]::IsNullOrWhiteSpace($zx)) {
    $cmd = Get-Command ZXPSignCMD -ErrorAction SilentlyContinue
    if ($cmd) { $zx = $cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($zx)) {
    $cmd = Get-Command ZXPSignCmd -ErrorAction SilentlyContinue
    if ($cmd) { $zx = $cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($zx)) {
    throw "ZXPSignCMD not found. Install it and set ZXPSIGN_CMD in $ConfigPath"
}
if (!(Test-Path $zx)) {
    $cmd = Get-Command $zx -ErrorAction SilentlyContinue
    if (!$cmd) { throw "ZXPSignCMD not executable: $zx" }
    $zx = $cmd.Source
}

if ([string]::IsNullOrWhiteSpace($certPath)) {
    $certPath = Join-Path $RootDir ".certs/VeoBridgeCert.p12"
}

if (!(Test-Path $certPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $certPath -Parent) | Out-Null
    if ([string]::IsNullOrWhiteSpace($certPassword)) {
        $secure = Read-Host "Enter certificate password" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $certPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    $certCountryValue = "US"
    if (![string]::IsNullOrWhiteSpace($certCountry)) { $certCountryValue = $certCountry }
    $certStateValue = "NA"
    if (![string]::IsNullOrWhiteSpace($certState)) { $certStateValue = $certState }
    $certCommonNameValue = "Veo Bridge Dev"
    if (![string]::IsNullOrWhiteSpace($certCommonName)) { $certCommonNameValue = $certCommonName }
    $certOrgValue = "Veo Bridge"
    if (![string]::IsNullOrWhiteSpace($certOrg)) { $certOrgValue = $certOrg }
    $certOrgUnitValue = "Extensions"
    if (![string]::IsNullOrWhiteSpace($certOrgUnit)) { $certOrgUnitValue = $certOrgUnit }

    & $zx -selfSignedCert `
        $certCountryValue `
        $certStateValue `
        $certOrgValue `
        $certCommonNameValue `
        $certPassword `
        $certPath `
        -orgUnit $certOrgUnitValue

    if ($LASTEXITCODE -ne 0) { throw "Failed to create certificate" }
    Write-Host "Created certificate: $certPath"
}

if ([string]::IsNullOrWhiteSpace($certPassword)) {
    $secure = Read-Host "Enter certificate password" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $certPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
if (Test-Path $StageDir) {
    Remove-Item -Recurse -Force -Path $StageDir
}
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

$requiredPaths = @("CSXS", "css", "js", "jsx", "index.html", "gallery.html")
foreach ($rel in $requiredPaths) {
    $src = Join-Path $RootDir $rel
    if (!(Test-Path $src)) {
        throw "Missing required path: $rel"
    }
    $dst = Join-Path $StageDir $rel
    Copy-Item -Path $src -Destination $dst -Recurse -Force
}

$outPath = Join-Path $DistDir $zxpName
if (Test-Path $outPath) {
    Remove-Item -Force -Path $outPath
}

& $zx -sign $StageDir $outPath $certPath $certPassword
if ($LASTEXITCODE -ne 0) { throw "ZXP signing failed" }

if (Test-Path $StageDir) {
    Remove-Item -Recurse -Force -Path $StageDir
}

Write-Host "Build complete: $outPath"
