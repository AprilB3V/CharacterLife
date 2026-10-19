#Requires -Version 5.1
<#
.SYNOPSIS
  CharacterLife · OneBot 11 启动脚本（Windows PowerShell 5.1 与 PowerShell 7 都能跑）

.DESCRIPTION
  做四件事：
    1) 读 .env（注意：本项目其他入口都不加载 .env，只有这个脚本加载）
    2) 体检：Node 版本 / node:sqlite / 必要变量 / 端口占用 / 网关连通性
    3) 启动 OneBot 上报服务（examples/onebot/server.ts），Ctrl+C 停止
    4) 可选：顺手拉起网关进程（-GatewayExe），退出时按需关掉

  优先级：命令行参数 > 环境变量（含 .env 载入的）> 代码默认值

.PARAMETER ApiBase
  网关 HTTP API 地址，例如 http://127.0.0.1:3000（对应 ONEBOT_API_BASE，必填）
.PARAMETER AccessToken
  网关 access_token（对应 ONEBOT_ACCESS_TOKEN）
.PARAMETER Secret
  上报签名密钥（对应 ONEBOT_SECRET）。不配置会给警告
.PARAMETER Port
  本服务监听端口（对应 ONEBOT_PORT，默认 8790）
.PARAMETER Path
  上报路径（对应 ONEBOT_PATH，默认 /onebot/event）
.PARAMETER Database
  SQLite 路径（对应 CHARACTERLIFE_DB，默认 data/characterlife.db）
  注意不叫 -Db：那会与内置通用参数 -Debug 的别名 db 冲突，脚本根本无法解析
.PARAMETER World
  世界线 id（对应 CHARACTERLIFE_WORLD，默认 world_onebot）
.PARAMETER EnvFile
  指定 env 文件（默认 <项目根>\.env）
.PARAMETER NoEnvFile
  完全不读 .env，只用当前进程环境变量
.PARAMETER SkipGatewayProbe
  跳过网关连通性探测（网关还没起、或故意先启动本服务时用）
.PARAMETER Probe
  只体检不启动（用它排查配置问题）
.PARAMETER Force
  .env 覆盖已存在的进程环境变量（默认不覆盖，符合 dotenv 惯例）
.PARAMETER GatewayExe
  可选：网关可执行文件路径，脚本会先把它拉起来再启动本服务
.PARAMETER GatewayArgs
  传给网关的参数，用逗号分隔（例：-GatewayArgs "--path,C:\cfg.json"）。
  故意是字符串而不是数组：用 -File 调用脚本时无法构造数组参数
.PARAMETER GatewayWaitSec
  等待网关 API 就绪的秒数（默认 15）
.PARAMETER KeepGateway
  退出时保留网关进程（默认：由本脚本拉起的网关会被关掉）

.EXAMPLE
  # 1) 先体检：不启动服务，只检查配置与网关
  .\scripts\start-onebot.cmd -Probe

.EXAMPLE
  # 2) 正常启动（读 .env）
  .\scripts\start-onebot.cmd

.EXAMPLE
  # 3) 用命令行临时指定（优先级高于 .env）
  .\scripts\start-onebot.cmd -ApiBase http://127.0.0.1:3000 -AccessToken mytoken -Secret mysecret

.EXAMPLE
  # 4) 连网关一起拉起来（网关参数用逗号分隔）
  .\scripts\start-onebot.cmd -GatewayExe C:\NapCat\NapCatWinBootMain.exe
  .\scripts\start-onebot.cmd -GatewayExe C:\Lagrange\Lagrange.OneBot.exe -GatewayArgs "--path,C:\Lagrange\appsettings.json"

.NOTES
  退出码：0 正常退出 / 2 体检或配置失败 / 其他 = node 的退出码
  编码：本文件是 UTF-8 with BOM（Windows PowerShell 5.1 不加 BOM 会把中文读成乱码）
#>
[CmdletBinding()]
param(
  [string]$ApiBase,
  [string]$AccessToken,
  [string]$Secret,
  [int]$Port = 0,
  [string]$Path,
  [string]$Database,
  [string]$World,
  [string]$EnvFile = '',
  [switch]$NoEnvFile,
  [switch]$SkipGatewayProbe,
  [switch]$Probe,
  [switch]$Force,
  [string]$GatewayExe,
  [string]$GatewayArgs = '',
  [int]$GatewayWaitSec = 15,
  [switch]$KeepGateway
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:HadWarning = $false

function Write-Head([string]$Text) { Write-Host ''; Write-Host "── $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "  [info] $Text" }
function Write-Warn2([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow; $script:HadWarning = $true }
function Write-Bad([string]$Text) { Write-Host "  [fail] $Text" -ForegroundColor Red }

function Stop-WithError([string]$Text, [int]$Code = 2) {
  Write-Bad $Text
  Write-Host ''
  exit $Code
}

function Mask-Value([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return '(未配置)' }
  if ($Value.Length -le 4) { return ('*' * $Value.Length) }
  return ($Value.Substring(0, 4) + '****（共 ' + $Value.Length + ' 位）')
}

# 中文是双宽字符，用 '{0,-22}' 对齐会歪。这里按显示宽度补空格。
function Get-DisplayWidth([string]$Text) {
  $width = 0
  foreach ($ch in $Text.ToCharArray()) {
    $code = [int][char]$ch
    $wide = (($code -ge 0x1100 -and $code -le 0x115F) -or
             ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
             ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
             ($code -ge 0xF900 -and $code -le 0xFAFF) -or
             ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
             ($code -ge 0xFF00 -and $code -le 0xFF60) -or
             ($code -ge 0xFFE0 -and $code -le 0xFFE6))
    if ($wide) { $width += 2 } else { $width += 1 }
  }
  return $width
}

function Format-Row([string]$Label, [string]$Value, [int]$Width = 24) {
  $pad = $Width - (Get-DisplayWidth $Label)
  if ($pad -lt 1) { $pad = 1 }
  return ('  ' + $Label + (' ' * $pad) + $Value)
}

# 网关返回的 JSON 里可能有中文（机器人昵称）。响应头没有 charset 时，
# Windows PowerShell 5.1 会按 ISO-8859-1 解码成乱码，所以这里统一按 UTF-8 重解。
function Invoke-GatewayJson([string]$Uri, [hashtable]$Headers, [int]$TimeoutSec = 5) {
  $response = $null
  try {
    $response = Invoke-WebRequest -Method Post -Uri $Uri -Headers $Headers -ContentType 'application/json' -Body '{}' -TimeoutSec $TimeoutSec -UseBasicParsing
  } catch {
    # 4xx/5xx：尽量把 body 读出来（PS 5.1 能拿到 HttpWebResponse 的流）
    $webResponse = $_.Exception.Response
    if ($webResponse) {
      try {
        $stream = $webResponse.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        $reader.Close()
        if (-not [string]::IsNullOrEmpty($text)) { return ($text | ConvertFrom-Json) }
      } catch { }
    }
    throw
  }
  $bytes = $null
  $props = $response.PSObject.Properties
  if ($props['RawContentStream'] -and $response.RawContentStream) {
    $bytes = $response.RawContentStream.ToArray()   # Windows PowerShell 5.1
  } elseif ($props['RawContent']) {
    $bytes = $response.RawContent                       # PowerShell 7：byte[]
  }
  if ($bytes) { return ([System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json) }
  return ($response.Content | ConvertFrom-Json)
}

# ── 项目根目录（脚本在 scripts/ 下）──────────────────────────────────────
$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$Entry = Join-Path $Root 'examples\onebot\server.ts'

# ── 1. 读 .env ──────────────────────────────────────────────────────────
# 只允许这些前缀：避免 .env 里一行笔误就把 NODE_OPTIONS 之类的变量也改了
$AllowedPrefixes = @('ONEBOT_', 'CHARACTERLIFE_', 'DEEPSEEK_', 'QQBOT_')

function Import-EnvFile([string]$File, [bool]$Override) {
  $result = @{ Loaded = 0; Skipped = 0; Kept = 0 }
  foreach ($rawLine in (Get-Content -LiteralPath $File -Encoding UTF8)) {
    $line = ([string]$rawLine).Trim()
    if ($line.Length -eq 0) { continue }
    if ($line.StartsWith('#')) { continue }
    if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { $result.Skipped++; continue }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2) {
      $quotedDouble = $value.StartsWith('"') -and $value.EndsWith('"')
      $quotedSingle = $value.StartsWith("'") -and $value.EndsWith("'")
      if ($quotedDouble -or $quotedSingle) { $value = $value.Substring(1, $value.Length - 2) }
    }
    $allowed = $false
    foreach ($prefix in $AllowedPrefixes) { if ($name.StartsWith($prefix)) { $allowed = $true } }
    if (-not $allowed) { $result.Skipped++; continue }
    $existing = [Environment]::GetEnvironmentVariable($name, 'Process')
    # 空值不覆盖已有值；已存在且没 -Force 时保留原值（dotenv 惯例）
    if ($value.Length -eq 0) { $result.Kept++; continue }
    if ((-not [string]::IsNullOrEmpty($existing)) -and (-not $Override)) { $result.Kept++; continue }
    Set-Item -Path ('Env:' + $name) -Value $value
    $result.Loaded++
  }
  return $result
}

Write-Head '1/4 载入配置'
if ($NoEnvFile) {
  Write-Info '-NoEnvFile：不读取 .env，只用当前进程环境变量'
} else {
  $envPath = $EnvFile
  if ([string]::IsNullOrEmpty($envPath)) { $envPath = Join-Path $Root '.env' }
  if (Test-Path -LiteralPath $envPath) {
    $stats = Import-EnvFile -File $envPath -Override ([bool]$Force)
    Write-Ok ("读取 $envPath（载入 {0} 项，保留已有 {1} 项，跳过 {2} 行）" -f $stats.Loaded, $stats.Kept, $stats.Skipped)
    if ($stats.Skipped -gt 0) {
      Write-Info "跳过的行：空行/注释/非 ONEBOT_·CHARACTERLIFE_·DEEPSEEK_·QQBOT_ 前缀"
    }
  } else {
    Write-Warn2 "没有找到 $envPath（可以复制 .env.example 为 .env；或用命令行参数直接传）"
  }
}

# ── 2. 命令行参数覆盖（最高优先级）──────────────────────────────────────
$fromParam = @()
if (-not [string]::IsNullOrEmpty($ApiBase)) { $env:ONEBOT_API_BASE = $ApiBase; $fromParam += 'ONEBOT_API_BASE' }
if (-not [string]::IsNullOrEmpty($AccessToken)) { $env:ONEBOT_ACCESS_TOKEN = $AccessToken; $fromParam += 'ONEBOT_ACCESS_TOKEN' }
if (-not [string]::IsNullOrEmpty($Secret)) { $env:ONEBOT_SECRET = $Secret; $fromParam += 'ONEBOT_SECRET' }
if ($Port -gt 0) { $env:ONEBOT_PORT = [string]$Port; $fromParam += 'ONEBOT_PORT' }
if (-not [string]::IsNullOrEmpty($Path)) { $env:ONEBOT_PATH = $Path; $fromParam += 'ONEBOT_PATH' }
if (-not [string]::IsNullOrEmpty($Database)) { $env:CHARACTERLIFE_DB = $Database; $fromParam += 'CHARACTERLIFE_DB' }
if (-not [string]::IsNullOrEmpty($World)) { $env:CHARACTERLIFE_WORLD = $World; $fromParam += 'CHARACTERLIFE_WORLD' }
if ($fromParam.Count -gt 0) { Write-Info ("命令行覆盖：" + ($fromParam -join ', ')) }

# ── 3. 体检 ─────────────────────────────────────────────────────────────
Write-Head '2/4 体检'

# 3.1 Node 版本
# 说明：Windows PowerShell 5.1 下调用原生命令有两个坑，这里都绕开：
#   1) 内嵌双引号会被吞掉 → JS 片段统一用单引号（见 3.2）
#   2) 原生命令的 stderr 会被包成 ErrorRecord，配合 $ErrorActionPreference='Stop' 直接终止脚本
#      → 探测类调用临时把 EAP 放宽，并且不用管道（管道会盖掉 $LASTEXITCODE 的可读性）
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Stop-WithError '找不到 node：请先安装 Node.js ≥ 22.6（https://nodejs.org）' }

$nodeVersion = ''
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $nodeVersion = [string]((& node -v 2>$null) | Select-Object -First 1) } catch { $nodeVersion = '' }
$ErrorActionPreference = $savedEap
$nodeVersion = $nodeVersion.Trim()
if ([string]::IsNullOrEmpty($nodeVersion)) { Stop-WithError '无法执行 node -v：请检查 Node.js 安装与 PATH' }

$major = 0; $minor = 0
if ($nodeVersion -match '^v(\d+)\.(\d+)') { $major = [int]$Matches[1]; $minor = [int]$Matches[2] }
$nodeOk = ($major -gt 22) -or (($major -eq 22) -and ($minor -ge 6))
if ($nodeOk) {
  Write-Ok "Node $nodeVersion"
} else {
  Stop-WithError "Node $nodeVersion 版本过低：本项目需要 ≥ 22.6（用到 node:sqlite）"
}

# 3.2 node:sqlite 可用性（版本够但模块没编进去的情况真实存在）
$sqliteProbe = "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))"
$sqliteExit = 1
$ErrorActionPreference = 'Continue'
try {
  & node -e $sqliteProbe 1>$null 2>$null
  $sqliteExit = $LASTEXITCODE
} catch {
  $sqliteExit = 1
}
$ErrorActionPreference = $savedEap
if ($sqliteExit -eq 0) {
  Write-Ok 'node:sqlite 可用（不需要任何数据库驱动）'
} else {
  Stop-WithError '当前 Node 的 node:sqlite 不可用：请升级到 ≥ 22.6 的官方发行版'
}

# 3.3 必要变量
$apiBase = [Environment]::GetEnvironmentVariable('ONEBOT_API_BASE', 'Process')
if ([string]::IsNullOrEmpty($apiBase)) {
  Stop-WithError @'
缺少 ONEBOT_API_BASE（网关 HTTP API 地址）。三种补法任选其一：
   1) 在项目根目录建 .env，写：ONEBOT_API_BASE=http://127.0.0.1:3000
   2) 传参：.\scripts\start-onebot.cmd -ApiBase http://127.0.0.1:3000
   3) 临时：$env:ONEBOT_API_BASE = 'http://127.0.0.1:3000'
'@
}
if ($apiBase -notmatch '^https?://') { Stop-WithError "ONEBOT_API_BASE 必须以 http:// 或 https:// 开头，当前：$apiBase" }
Write-Ok "网关 API：$apiBase"

$accessToken = [Environment]::GetEnvironmentVariable('ONEBOT_ACCESS_TOKEN', 'Process')
$secret = [Environment]::GetEnvironmentVariable('ONEBOT_SECRET', 'Process')
$hostName = [Environment]::GetEnvironmentVariable('ONEBOT_HOST', 'Process')
if ([string]::IsNullOrEmpty($hostName)) { $hostName = '127.0.0.1' }
$portValue = [Environment]::GetEnvironmentVariable('ONEBOT_PORT', 'Process')
if ([string]::IsNullOrEmpty($portValue)) { $portValue = '8790' }
$portNum = 0
if (-not [int]::TryParse($portValue, [ref]$portNum)) { Stop-WithError "ONEBOT_PORT 不是合法端口：$portValue" }
$eventPath = [Environment]::GetEnvironmentVariable('ONEBOT_PATH', 'Process')
if ([string]::IsNullOrEmpty($eventPath)) { $eventPath = '/onebot/event' }
if (-not $eventPath.StartsWith('/')) { $eventPath = '/' + $eventPath }

if ([string]::IsNullOrEmpty($secret)) {
  Write-Warn2 '没有配置 ONEBOT_SECRET：上报接口不验签，本机任何进程都能伪造消息（生产务必配置）'
} else {
  Write-Ok 'ONEBOT_SECRET 已配置（上报验签开启）'
}

$allowPublic = [Environment]::GetEnvironmentVariable('ONEBOT_ALLOW_PUBLIC', 'Process')
$loopback = @('127.0.0.1', 'localhost', '::1') -contains $hostName
if (-not $loopback -and $allowPublic -ne 'true') {
  Stop-WithError @"
ONEBOT_HOST=$hostName 是非回环地址，但没有开 ONEBOT_ALLOW_PUBLIC=true，服务会拒绝启动。
   跨机部署：在 .env 里加 ONEBOT_ALLOW_PUBLIC=true，并确保网络层有访问控制（不要裸奔在公网）
   本机部署：把 ONEBOT_HOST 改回 127.0.0.1
"@
}
if (-not $loopback) { Write-Warn2 "监听 $hostName（非回环）：请确认这是有意的，并且有防火墙/反代保护" }

# 3.4 端口占用
function Test-PortBusy([string]$HostName, [int]$PortNumber) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($HostName, $PortNumber)
    if ($task.Wait(400) -and $client.Connected) { return $true }
    return $false
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

if (Test-PortBusy -HostName $hostName -PortNumber $portNum) {
  Stop-WithError @"
端口 $portNum 已被占用（$hostName）。可能是已经在跑一个实例。
   查看占用：netstat -ano | findstr :$portNum
   换端口：  .\scripts\start-onebot.cmd -Port 8791
"@
}
Write-Ok "端口 $portNum 空闲"

# 3.5 网关连通性（探测 get_login_info）
if (-not $SkipGatewayProbe) {
  $probeUri = $apiBase.TrimEnd('/') + '/get_login_info'
  $probeHeaders = @{}
  if (-not [string]::IsNullOrEmpty($accessToken)) { $probeHeaders['Authorization'] = 'Bearer ' + $accessToken }
  $probeOk = $false
  try {
    $loginInfo = Invoke-GatewayJson -Uri $probeUri -Headers $probeHeaders -TimeoutSec 5
    if ($loginInfo -ne $null -and $loginInfo.status -eq 'ok') {
      $probeOk = $true
      $selfId = $loginInfo.data.user_id
      $nick = $loginInfo.data.nickname
      Write-Ok "网关在线：QQ $selfId（$nick）"
      if ([string]::IsNullOrEmpty($env:ONEBOT_SELF_ID)) { Write-Info "建议在 .env 里写 ONEBOT_SELF_ID=$selfId（部分网关事件不带 self_id，群里 @ 判断会用到）" }
    } else {
      Write-Warn2 "网关有响应但不是 ok：$($loginInfo | ConvertTo-Json -Compress)"
    }
  } catch {
    Write-Warn2 "连不上网关 $probeUri（$($_.Exception.Message)）"
    Write-Info '服务仍会启动，但回复发不出去。网关起来后再试，或用 -SkipGatewayProbe 静音此检查'
  }
  if (-not $probeOk -and -not [string]::IsNullOrEmpty($accessToken)) {
    Write-Info "若返回 401/403，请检查 ONEBOT_ACCESS_TOKEN 与网关 http server 的 token 是否一致"
  }
} else {
  Write-Info '已跳过网关探测（-SkipGatewayProbe）'
}

# ── 4. 汇总 ─────────────────────────────────────────────────────────────
$dbValue = [Environment]::GetEnvironmentVariable('CHARACTERLIFE_DB', 'Process')
if ([string]::IsNullOrEmpty($dbValue)) { $dbValue = 'data/characterlife.db' }
$worldValue = [Environment]::GetEnvironmentVariable('CHARACTERLIFE_WORLD', 'Process')
if ([string]::IsNullOrEmpty($worldValue)) { $worldValue = 'world_onebot' }
$mentionOnly = [Environment]::GetEnvironmentVariable('ONEBOT_GROUP_MENTION_ONLY', 'Process')
$groupPolicy = '仅被 @ 或 /指令时回应'
if ($mentionOnly -eq 'false') { $groupPolicy = '每条群消息都回（慎用：刷屏 + 风控）' }
$anon = [Environment]::GetEnvironmentVariable('ONEBOT_ANONYMIZE', 'Process')
$privacy = 'QQ 号哈希为假名后落库'
if ($anon -eq 'false') { $privacy = '直接存 QQ 号（隐私风险）' }
$provider = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'Process')
if ([string]::IsNullOrEmpty($provider)) { $providerText = 'MockProvider（未配置 DEEPSEEK_API_KEY，回复是固定台词）' } else { $providerText = 'DeepSeek（已配置 DEEPSEEK_API_KEY）' }

Write-Head '3/4 启动配置'
Write-Host (Format-Row 'ONEBOT_API_BASE' $apiBase)
Write-Host (Format-Row 'ONEBOT_ACCESS_TOKEN' (Mask-Value $accessToken))
Write-Host (Format-Row 'ONEBOT_SECRET' (Mask-Value $secret))
Write-Host (Format-Row '上报地址' ("http://{0}:{1}{2}" -f $hostName, $portNum, $eventPath))
Write-Host (Format-Row '数据库' $dbValue)
Write-Host (Format-Row '世界线' $worldValue)
Write-Host (Format-Row '群聊策略' $groupPolicy)
Write-Host (Format-Row '隐私' $privacy)
Write-Host (Format-Row '模型' $providerText)

Write-Head '把下面这些填进网关'
Write-Host '  HTTP API    : 监听 127.0.0.1:' -NoNewline
Write-Host ($apiBase -replace '^https?://[^:]+:', '') -ForegroundColor White
Write-Host '                token = ' -NoNewline
Write-Host (Mask-Value $accessToken) -ForegroundColor White
Write-Host '  HTTP 上报   : URL    = ' -NoNewline
Write-Host ("http://{0}:{1}{2}" -f $hostName, $portNum, $eventPath) -ForegroundColor White
Write-Host '                secret = ' -NoNewline
Write-Host (Mask-Value $secret) -ForegroundColor White
Write-Host '                格式   =  array 或 string 都可以'
Write-Host '  不要开启    :  WebSocket / 反向 WS（本项目只走 HTTP）' -ForegroundColor DarkGray

if ($Probe) {
  Write-Head '4/4 结果'
  if ($script:HadWarning) {
    Write-Warn2 '体检通过，但有上面的警告'
  } else {
    Write-Ok '体检通过'
  }
  Write-Info '这是 -Probe 模式：没有启动服务。去掉 -Probe 即可启动'
  exit 0
}

# ── 5. 启动 ─────────────────────────────────────────────────────────────
$gatewayProcess = $null
if (-not [string]::IsNullOrEmpty($GatewayExe)) {
  $resolvedGateway = $GatewayExe
  if (-not (Test-Path -LiteralPath $resolvedGateway)) {
    $onPath = Get-Command $GatewayExe -ErrorAction SilentlyContinue
    if ($onPath) { $resolvedGateway = $onPath.Source } else { Stop-WithError "找不到网关可执行文件：$GatewayExe" }
  }
  Write-Head '启动网关'
  $gatewayDir = Split-Path -Parent (Resolve-Path -LiteralPath $resolvedGateway).Path
  $startArgs = @{ FilePath = $resolvedGateway; WorkingDirectory = $gatewayDir; PassThru = $true }
  # -File 调用时无法传数组，所以这里按逗号切分（保留含空格的单个参数需用引号包住整串）
  $gatewayArgList = @()
  if (-not [string]::IsNullOrWhiteSpace($GatewayArgs)) {
    $gatewayArgList = @($GatewayArgs -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  }
  if ($gatewayArgList.Count -gt 0) { $startArgs['ArgumentList'] = $gatewayArgList }
  $gatewayProcess = Start-Process @startArgs
  Write-Ok ("已拉起网关 pid={0}（登录二维码可能在新窗口里，扫码即可）" -f $gatewayProcess.Id)
  $ready = $false
  $waited = 0
  for ($i = 1; $i -le $GatewayWaitSec; $i++) {
    Start-Sleep -Seconds 1
    $waited = $i
    if ($gatewayProcess.HasExited) { break }
    try {
      $uri = $apiBase.TrimEnd('/') + '/get_login_info'
      $headers = @{}
      if (-not [string]::IsNullOrEmpty($accessToken)) { $headers['Authorization'] = 'Bearer ' + $accessToken }
      $info = Invoke-GatewayJson -Uri $uri -Headers $headers -TimeoutSec 3
      if ($info -and $info.status -eq 'ok') { Write-Ok ("网关就绪：QQ {0}" -f $info.data.user_id); $ready = $true; break }
    } catch { }
  }
  if (-not $ready) {
    if ($gatewayProcess.HasExited) {
      $gwExit = '未知'
      try { $gwExit = $gatewayProcess.ExitCode } catch { }
      Write-Warn2 ("网关进程已退出（退出码 $gwExit），本服务仍会启动但发不出消息")
      Write-Info '常见原因：-GatewayArgs 里的相对路径是相对「网关自己所在目录」解析的，请改用绝对路径；或网关自身启动失败需要单独排查'
    } else {
      Write-Warn2 "等了 $waited 秒，网关 API 还没就绪（可能需要先扫码登录）；仍继续启动本服务"
    }
  }
}

Write-Head '4/4 启动服务'
Write-Info "工作目录：$Root"
Write-Info '停止：Ctrl+C'
Write-Host ''

$exitCode = 0
Push-Location $Root
try {
  & node $Entry
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
  if ($gatewayProcess -and (-not $KeepGateway) -and (-not $gatewayProcess.HasExited)) {
    Write-Host ''
    Write-Info ("关闭由本脚本拉起的网关 pid={0}（要保留请加 -KeepGateway）" -f $gatewayProcess.Id)
    try { Stop-Process -Id $gatewayProcess.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

if ($exitCode -ne 0) {
  Write-Host ''
  Write-Warn2 "服务退出，退出码 $exitCode（配置类问题看上面 [fail]，运行期问题看日志的 reason 字段）"
}
exit $exitCode
