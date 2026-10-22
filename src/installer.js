// Builds "Peacedone-Helper-Setup.cmd" on the fly: a tiny one-time installer for the folder helper,
// pre-filled with THIS extension's id, so the user only has to open the downloaded file once.
// The .cmd hands its own tail (a PowerShell script) to PowerShell, which ships with every Windows:
// no Python, no admin rights. It writes %LOCALAPPDATA%\Peacedone and one HKCU registry key per browser.
(function (root) {
  const HOST = 'com.peacedone.recorder';

  function b64(text) {
    const bytes = new TextEncoder().encode(text);
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function build() {
    const hostPs1 = await (await fetch(chrome.runtime.getURL('helper/peacedone-host.ps1'))).text();
    const origins = `'chrome-extension://${chrome.runtime.id}/'`;
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      "$dir = Join-Path $env:LOCALAPPDATA 'Peacedone'",
      "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
      `[IO.File]::WriteAllBytes((Join-Path $dir 'peacedone-host.ps1'), [Convert]::FromBase64String('${b64(hostPs1)}'))`,
      "[IO.File]::WriteAllText((Join-Path $dir 'peacedone-host.bat'), \"@powershell -NoProfile -ExecutionPolicy Bypass -File `\"%~dp0peacedone-host.ps1`\"`r`n\")",
      `$m = [ordered]@{ name = '${HOST}'; description = 'Peacedone Recorder folder helper'; path = (Join-Path $dir 'peacedone-host.bat'); type = 'stdio'; allowed_origins = @(${origins}) }`,
      "$json = Join-Path $dir 'host.json'",
      "[IO.File]::WriteAllText($json, ($m | ConvertTo-Json))",
      "foreach ($b in 'Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser', 'Chromium') {",
      `  New-Item -Force -Path "HKCU:\\Software\\$b\\NativeMessagingHosts\\${HOST}" -Value $json | Out-Null`,
      "}",
      "Write-Host ''",
      "Write-Host '  Peacedone helper installed. Go back to Chrome and choose your folder.' -ForegroundColor Green",
    ].join('\r\n');
    const cmd = [
      '@echo off',
      'title Peacedone helper setup',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText('%~f0'); $i=$s.LastIndexOf('#PEACEDONE'+'-PAYLOAD'); Invoke-Expression $s.Substring($i)"`,
      'if errorlevel 1 (echo. & echo   Something went wrong. Send a screenshot of this window. & pause & exit /b 1)',
      'timeout /t 4 >nul',
      'exit /b 0',
      '#PEACEDONE-PAYLOAD',
      ps,
      ''
    ].join('\r\n');
    return cmd;
  }

  // Download (and, when Chrome allows, open) the installer. Returns the download id.
  async function download() {
    const text = await build();
    const id = await chrome.downloads.download({
      url: 'data:application/octet-stream;base64,' + b64(text),
      filename: 'Peacedone-Helper-Setup.cmd', conflictAction: 'overwrite', saveAs: false
    });
    return id;
  }

  root.IR_INSTALLER = { build, download };
})(globalThis);
