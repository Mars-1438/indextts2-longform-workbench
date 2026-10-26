# 下载一份 ffmpeg 到 bin/（可选脚本）
#
# 为什么单独用脚本：ffmpeg 二进制约 85MB，而且不同构建的许可证不同（LGPL / GPL）。
# 把二进制放进 git 仓库既臃肿又不合适，所以「用的时候再下」。
#
# 用法（在整合包根目录）：
#   powershell -ExecutionPolicy Bypass -File tools\fetch_ffmpeg.ps1
#   powershell -ExecutionPolicy Bypass -File tools\fetch_ffmpeg.ps1 -Url <你自己的 ffmpeg 压缩包直链>
#
# 默认下载 gyan.dev 的 essentials build（Windows x64）。
# 该构建是 GPL 版；如果你要分发它，请一并遵守 GPL（提供许可文本与源码获取方式）。

param(
    [string]$Url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    [string]$BinDir = "bin"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bin = Join-Path $root $BinDir
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$tmp = Join-Path $env:TEMP ("ffmpeg_" + [guid]::NewGuid().ToString("n") + ".zip")
Write-Host "下载：$Url"
Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing

Write-Host "解压…"
$stage = Join-Path $env:TEMP ("ffmpeg_" + [guid]::NewGuid().ToString("n"))
Expand-Archive -Path $tmp -DestinationPath $stage -Force
$exe = Get-ChildItem -Path $stage -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $exe) { throw "压缩包里没找到 ffmpeg.exe" }

Copy-Item $exe.FullName (Join-Path $bin "ffmpeg.exe") -Force
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$target = Join-Path $bin "ffmpeg.exe"
$ver = & $target -version 2>$null | Select-Object -First 1
if (-not $ver) { throw "装好了但跑不起来：$target" }

Write-Host ""
Write-Host "完成：$target"
Write-Host "版本：$ver"
Write-Host "提示：重启服务后，导入台底部会显示绿点「ffmpeg 已就绪」。"
