# 把 NeeYoonc/dsh-nas 最新 Release 的 SPK 同步到本套件源（R2）。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts\sync-latest-release.ps1 [-Force] [-DryRun]
#
# 环境变量:
#   DSH_REPO / PKG_DIR / R2_BUCKET / UPLOAD_BACKEND（wrangler 或 s3）/ WRANGLER_CMD / PYTHON
#
# 依赖: gh（已登录）、python；wrangler 后端还需要已 wrangler login

param(
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$Repo = if ($env:DSH_REPO) { $env:DSH_REPO } else { 'NeeYoonc/dsh-nas' }
$PkgDir = if ($env:PKG_DIR) { $env:PKG_DIR } else { 'packages' }
$Bucket = if ($env:R2_BUCKET) { $env:R2_BUCKET } else { 'sspks' }
$UploadBackend = if ($env:UPLOAD_BACKEND) { $env:UPLOAD_BACKEND } else { 'wrangler' }
$WranglerCmd = if ($env:WRANGLER_CMD) { $env:WRANGLER_CMD } else { 'npx wrangler' }
$Python = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
$Marker = Join-Path $PkgDir '.synced-release'

if ($UploadBackend -notin @('wrangler', 's3')) {
    throw "UPLOAD_BACKEND 只能是 wrangler 或 s3（当前: $UploadBackend）"
}

$Tag = gh release view -R $Repo --json tagName -q '.tagName'
if (-not $Tag -or $Tag -eq 'null') { throw "无法获取 $Repo 的最新 Release" }
Write-Host "最新 Release: $Tag"

if (-not $Force -and (Test-Path $Marker) -and ((Get-Content $Marker -Raw).Trim() -eq $Tag)) {
    Write-Host "已同步过 $Tag（-Force 可强制重跑）"
    exit 0
}

$Assets = @(gh release view $Tag -R $Repo --json assets -q '.assets[].name' | Where-Object { $_ -like '*.spk' })
if ($Assets.Count -eq 0) { throw "Release $Tag 没有 .spk 资产" }

New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null
foreach ($Name in $Assets) {
    $Target = Join-Path $PkgDir $Name
    if (Test-Path $Target) {
        Write-Host "已存在: $Name"
    } else {
        Write-Host "下载: $Name"
        gh release download $Tag -R $Repo -D $PkgDir -p $Name --clobber
    }
}

$DeleteScript = @'
import sys
sys.path.insert(0, "tools")
from r2 import client_from_env

client = client_from_env(sys.argv[1])
for key in sys.argv[2:]:
    client.delete(key)
'@

function Remove-RemoteObject([string]$Name) {
    $Stem = [System.IO.Path]::GetFileNameWithoutExtension($Name)
    if ($UploadBackend -eq 'wrangler') {
        & cmd /c "$WranglerCmd r2 object delete ""$Bucket/spk/packages/$Name""" | Out-Null
        foreach ($Size in 72, 120) {
            & cmd /c "$WranglerCmd r2 object delete ""$Bucket/spk/icons/${Stem}_thumb_$Size.png""" | Out-Null
        }
    } else {
        $KeyArgs = @("spk/packages/$Name", "spk/icons/${Stem}_thumb_72.png", "spk/icons/${Stem}_thumb_120.png")
        & $Python -c $DeleteScript $Bucket @KeyArgs | Out-Null
    }
}

# 旧版本的包不进索引：本地文件先删，远端对象等新索引上传后再清理（避免下载 404）。
$PruneList = @()
Get-ChildItem $PkgDir -Filter *.spk | ForEach-Object {
    if ($Assets -notcontains $_.Name) {
        Write-Host "移除旧包: $($_.Name)"
        $PruneList += $_.Name
        Remove-Item $_.FullName -Force
    }
}

Write-Host "重建索引..."
& $Python tools/index.py --pretty
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$UploadArgs = @('tools/index.py', '--upload', '--bucket', $Bucket)
if ($UploadBackend -eq 'wrangler') {
    $UploadArgs += @('--upload-backend', 'wrangler', '--wrangler-cmd', $WranglerCmd)
}
if ($DryRun) { $UploadArgs += '--dry-run' }
& $Python @UploadArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $DryRun) {
    foreach ($Name in $PruneList) { Remove-RemoteObject $Name }
    Set-Content -Path $Marker -Value $Tag -NoNewline
    Write-Host "已同步 $Tag（Worker 索引缓存最多 5 分钟）"
}
