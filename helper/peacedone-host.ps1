# Peacedone Recorder helper — Chrome native messaging host, Windows PowerShell 5.1 (built into Windows, no Python).
# Chrome starts it on demand and talks over stdin/stdout (4-byte length + UTF-8 JSON). It can only:
#   ping | pick {dir?} (Windows "choose folder" dialog) | check {dir} | test {dir} | write {dir, files:[{name,text}]}
# Files: only .md/.json/.txt directly in the folder or in raw/. No network.
$ErrorActionPreference = 'Stop'
$VERSION = 2
$LOG = Join-Path $PSScriptRoot 'host.log'
function Log($t) { try { Add-Content -LiteralPath $LOG -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss ') + $t) -Encoding UTF8 } catch {} }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PdPicker {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
        void SetOptions(uint fos); void GetOptions(out uint fos);
        void SetDefaultFolder(IShellItem psi); void SetFolder(IShellItem psi);
        void GetFolder(); void GetCurrentSelection();
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name); void GetFileName();
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text); void SetFileNameLabel();
        void GetResult(out IShellItem ppsi);
    }
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(); void GetParent();
        void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(); void Compare();
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    public static string Pick(string start, string title) {
        IntPtr owner = GetForegroundWindow();          // the Chrome window: the dialog opens modal on top of it
        uint fg = GetWindowThreadProcessId(owner, IntPtr.Zero), me = GetCurrentThreadId();
        bool attached = owner != IntPtr.Zero && AttachThreadInput(me, fg, true);
        try {
            IFileDialog d = (IFileDialog)new FileOpenDialogRCW();
            d.SetOptions(0x20 | 0x40 | 0x800);           // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
            d.SetTitle(title);
            d.SetOkButtonLabel("Use this folder");
            if (!string.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
                IShellItem si; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out si); d.SetFolder(si);
            }
            if (d.Show(owner) != 0) return "";             // cancelled
            IShellItem r; d.GetResult(out r);
            string path; r.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
            return path;
        } finally { if (attached) AttachThreadInput(me, fg, false); }
    }
}
'@

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Exact([int]$n) {
    $buf = New-Object byte[] $n; $off = 0
    while ($off -lt $n) { $r = $stdin.Read($buf, $off, $n - $off); if ($r -le 0) { return $null }; $off += $r }
    return $buf
}
function Send($obj) {
    $bytes = $utf8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 5))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4); $stdout.Write($bytes, 0, $bytes.Length); $stdout.Flush()
}
function Resolve-Folder($d) {
    $d = [Environment]::ExpandEnvironmentVariables(("" + $d).Trim().Trim('"'))
    if (-not $d -or -not [IO.Path]::IsPathRooted($d)) { throw 'Folder must be a full path' }
    return [IO.Path]::GetFullPath($d)
}
$NAME = '^(raw/)?[^\\/:*?"<>|\x00-\x1f]{1,180}\.(md|json|txt)$'
function Write-One($base, $name, $text) {
    if ($name -notmatch $NAME -or $name.Contains('..')) { throw "bad file name: $name" }
    $path = Join-Path $base ($name -replace '/', '\')
    $dir = Split-Path $path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $tmp = "$path.ir-tmp"
    [IO.File]::WriteAllText($tmp, $text, $utf8)
    Move-Item -LiteralPath $tmp -Destination $path -Force    # never leave a half-written transcript
    return $path
}

function Handle($m) {
    switch ($m.cmd) {
        'ping' { return @{ ok = $true; version = $VERSION } }
        'pick' { $p = [PdPicker]::Pick("" + $m.dir, 'Folder for this call transcript'); Log "pick -> $p"; return @{ ok = $true; dir = $p } }
        'check' {
            $d = Resolve-Folder $m.dir; $ex = Test-Path -LiteralPath $d -PathType Container
            $w = $false; if ($ex) { try { $t = Join-Path $d '.pd-w'; [IO.File]::WriteAllText($t, ''); Remove-Item -LiteralPath $t; $w = $true } catch {} }
            return @{ ok = $true; version = $VERSION; dir = $d; exists = $ex; writable = $w }
        }
        'test' {
            $d = Resolve-Folder $m.dir
            if (-not (Test-Path -LiteralPath $d -PathType Container)) { return @{ ok = $false; error = "Folder does not exist: $d" } }
            $p = Write-One $d '.peacedone-test.txt' 'test'; Remove-Item -LiteralPath $p; return @{ ok = $true; dir = $d }
        }
        'write' {
            $d = Resolve-Folder $m.dir
            if (-not (Test-Path -LiteralPath $d -PathType Container)) { return @{ ok = $false; error = "Folder does not exist: $d" } }
            $out = @(); foreach ($f in $m.files) { $out += (Write-One $d $f.name $f.text) }
            return @{ ok = $true; dir = $d; written = $out }
        }
        default { return @{ ok = $false; error = 'unknown command' } }
    }
}

while ($true) {
    $len = Read-Exact 4
    if ($null -eq $len) { break }
    $body = Read-Exact ([BitConverter]::ToInt32($len, 0))
    if ($null -eq $body) { break }
    try {
        $msg = $utf8.GetString($body) | ConvertFrom-Json
        Log ("cmd " + $msg.cmd)
        Send (Handle $msg)
    } catch {
        Log ("error " + $_.Exception.Message)
        Send @{ ok = $false; error = $_.Exception.Message }
    }
}
