# 把当前仓库推送到 GitHub（在本仓库里已经 init + add 过，这里补齐 commit/remote/push）
# 用法：powershell -ExecutionPolicy Bypass -File tools\push-github.ps1 [-Remote <url>] [-Message <提交信息>]
param(
  [string]$Remote = 'https://github.com/Tangoyzx/MultiTankLomix',
  [string]$Message = 'feat: 双人回合制坦克大战网页版（本地双人 + 远端接口预留）',
  [string]$UpdateMessage = 'chore: 修复推送脚本（origin 不存在时的处理）'
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# git 会把状态信息写到 stderr，Stop 模式下会误伤，这里单独放行原生命令
function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git @GitArgs
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

if (-not (Test-Path '.git')) { Invoke-Git init | Out-Null }
Invoke-Git add -A | Out-Null

Invoke-Git rev-parse --verify HEAD | Out-Null
$hasCommit = $LASTEXITCODE -eq 0
# diff --cached --quiet 退出码 1 = 有已暂存的改动
Invoke-Git diff --cached --quiet | Out-Null
$hasStaged = $LASTEXITCODE -ne 0
if (-not $hasCommit) {
  Invoke-Git commit -m $Message | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '首次提交失败，检查上面的 git 输出' }
} elseif ($hasStaged) {
  Invoke-Git commit -m $UpdateMessage | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '提交失败，检查上面的 git 输出' }
} else {
  Write-Host '没有待提交的改动，直接推送'
}

Invoke-Git branch -M main | Out-Null

Invoke-Git remote get-url origin | Out-Null
if ($LASTEXITCODE -eq 0) {
  Invoke-Git remote set-url origin $Remote | Out-Null
} else {
  Invoke-Git remote add origin $Remote | Out-Null
}

Write-Host "推送到 $Remote (main)"
Invoke-Git push -u origin main
if ($LASTEXITCODE -ne 0) { throw "推送失败（退出码 $LASTEXITCODE）。若远端已有初始提交，先 git pull --rebase origin main 再重跑" }
