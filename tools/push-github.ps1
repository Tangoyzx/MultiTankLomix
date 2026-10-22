# 把当前仓库推送到 GitHub（在本仓库里已经 init + add 过，这里补齐 commit/remote/push）
# 用法：powershell -ExecutionPolicy Bypass -File tools\push-github.ps1 [-Remote <url>] [-Message <提交信息>]
param(
  [string]$Remote = 'https://github.com/Tangoyzx/MultiTankLomix',
  [string]$Message = 'feat: 双人回合制坦克大战网页版（本地双人 + 远端接口预留）'
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Test-Path '.git')) { git init }
git add -A

# 没有提交记录时才创建首次提交，重复执行安全
$hasCommit = $false
try { git rev-parse --verify HEAD *> $null; $hasCommit = $LASTEXITCODE -eq 0 } catch {}
if (-not $hasCommit) {
  git commit -m $Message
} else {
  Write-Host '已有提交，跳过首次提交（如需重新提交请先 git reset --soft <起点>）'
}

git branch -M main
git remote remove origin 2>$null | Out-Null
git remote add origin $Remote
git push -u origin main