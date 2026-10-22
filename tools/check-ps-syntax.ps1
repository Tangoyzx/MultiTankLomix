# 校验 push-github.ps1 的 PowerShell 语法
$path = Join-Path $PSScriptRoot 'push-github.ps1'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors -and $errors.Count -gt 0) {
  $errors | ForEach-Object { Write-Host $_.Message }
  exit 1
}
Write-Host "语法OK: $path"
