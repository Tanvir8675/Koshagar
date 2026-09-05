# set-password.ps1 — set an account's password directly, without email.
#
# WHY THIS EXISTS
# The reset-by-email path has two moving parts that fail independently: the mail
# service (Supabase's built-in one allows only a couple of messages an hour) and
# the code in the email (which is dead if a mail client fetched the link first,
# or if the code came from the "magic link" button rather than the "password
# recovery" one). When someone is locked out, neither of those is worth
# debugging first - set the password and get them in.
#
# THE PASSWORD IS TYPED, NEVER PASSED AS AN ARGUMENT
# It is read with -AsSecureString, so it does not appear on screen, does not go
# into PowerShell history, and is not visible to anything listing processes.
# The service key is read from .env.local, so it is not typed here either.
#
# USAGE, from the project folder:
#
#   .\tools\set-password.ps1 -Email someone@example.com
#
# If PowerShell refuses to run the file ("running scripts is disabled"), either
#   powershell -ExecutionPolicy Bypass -File .\tools\set-password.ps1 -Email ...
# or set the policy once for yourself:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

param(
  [Parameter(Mandatory = $true)][string]$Email
)

$ErrorActionPreference = 'Stop'

# ---- read SUPABASE_URL and SUPABASE_SERVICE_KEY out of .env.local ----------
$envFile = Join-Path $PSScriptRoot '..\.env.local'
if (-not (Test-Path $envFile)) {
  Write-Error "No .env.local found. It needs SUPABASE_URL and SUPABASE_SERVICE_KEY."
}
$cfg = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $cfg[$Matches[1]] = $Matches[2] }
}
$url = $cfg['SUPABASE_URL']
$key = $cfg['SUPABASE_SERVICE_KEY']
if (-not $url -or -not $key) {
  Write-Error "SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from .env.local."
}
$url = $url.TrimEnd('/')

$headers = @{ apikey = $key; Authorization = "Bearer $key"; 'Content-Type' = 'application/json' }

# ---- find the account ------------------------------------------------------
Write-Host "Looking up $Email ..."
$list = Invoke-RestMethod -Uri "$url/auth/v1/admin/users" -Headers $headers -Method Get
$user = $list.users | Where-Object { $_.email -eq $Email }
if (-not $user) {
  Write-Error "No account with the email $Email. Check the spelling, or sign up first."
}
Write-Host ("Found: {0}  (id {1})" -f $user.email, $user.id)

# ---- the password, typed and never echoed ---------------------------------
$p1 = Read-Host 'New password (at least 6 characters)' -AsSecureString
$p2 = Read-Host 'Type it again' -AsSecureString
$b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1)
$b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
try {
  $plain1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1)
  $plain2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)
  if ($plain1 -ne $plain2)     { Write-Error 'The two passwords do not match. Nothing was changed.' }
  if ($plain1.Length -lt 6)    { Write-Error 'Too short - at least 6 characters. Nothing was changed.' }

  $body = @{ password = $plain1; email_confirm = $true } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$url/auth/v1/admin/users/$($user.id)" -Headers $headers -Method Put -Body $body | Out-Null
  Write-Host ''
  Write-Host "Password set for $Email. Sign in with it now - no email, no code." -ForegroundColor Green
}
finally {
  # Clear the plaintext out of memory rather than leaving it for the GC.
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
  Remove-Variable plain1, plain2 -ErrorAction SilentlyContinue
}
