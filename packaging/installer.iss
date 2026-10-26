; AutoSubtitle 字幕工房 — Windows 安裝程式（Inno Setup 6）
; CI 用法：
;   ISCC.exe /DAppVersion=1.2.3 /DSourceDir=<dist\AutoSubtitle> /DOutDir=<輸出資料夾> /DOutName=<檔名> packaging\installer.iss
; 預設安裝到使用者自己的資料夾（%LOCALAPPDATA%\Programs\AutoSubtitle），不需要系統管理員權限。

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\AutoSubtitle"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif
#ifndef AppNumVersion
  #define AppNumVersion "0.0.0"
#endif
#ifndef OutName
  #define OutName "AutoSubtitle-Setup"
#endif

[Setup]
; AppId 固定不變，升級時才會覆蓋舊版而不是裝兩份
AppId={{F02CF81B-D3F2-51D9-BE73-5D7916A6C1FE}
AppName=AutoSubtitle 字幕工房
AppVersion={#AppVersion}
AppVerName=AutoSubtitle 字幕工房 {#AppVersion}
AppPublisher=郭家齊
AppPublisherURL=https://github.com/alextixu/AutoSubtitle
AppSupportURL=https://github.com/alextixu/AutoSubtitle/issues
AppUpdatesURL=https://github.com/alextixu/AutoSubtitle/releases
DefaultDirName={autopf}\AutoSubtitle
DefaultGroupName=AutoSubtitle 字幕工房
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename={#OutName}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\AutoSubtitle.exe
UninstallDisplayName=AutoSubtitle 字幕工房
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
LicenseFile=..\LICENSE
VersionInfoVersion={#AppNumVersion}
VersionInfoProductName=AutoSubtitle
VersionInfoProductTextVersion={#AppVersion}
VersionInfoCompany=郭家齊

; 繁體中文翻譯：Inno Setup 6.4 起是官方內建語言（compiler:Languages\ChineseTraditional.isl）；
; 舊版編譯器沒有時，退回只有英文，不讓建置失敗。
#if FileExists(AddBackslash(CompilerPath) + "Languages\ChineseTraditional.isl")
  #define ZhTw "compiler:Languages\ChineseTraditional.isl"
#elif FileExists(AddBackslash(SourcePath) + "ChineseTraditional.isl")
  #define ZhTw "ChineseTraditional.isl"
#endif

[Languages]
#ifdef ZhTw
Name: "zh_tw"; MessagesFile: "{#ZhTw}"
#endif
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
#ifdef ZhTw
zh_tw.DesktopIcon=建立桌面捷徑
zh_tw.LaunchApp=啟動 AutoSubtitle 字幕工房
zh_tw.NoWebView2=這台電腦沒有安裝 Microsoft Edge WebView2 Runtime，AutoSubtitle 的介面需要它。%n%n安裝完成後請先安裝 WebView2（免費，約 2 MB 的安裝程式）。%n要現在開啟下載頁嗎？
zh_tw.AskDeleteData=要一併刪除下載的模型、專案、詞庫與設定嗎？%n%n位置：%1%n%n你的逐字稿輸出（文件\AutoSubtitle）不會被刪除。
#endif
en.DesktopIcon=Create a desktop shortcut
en.LaunchApp=Launch AutoSubtitle
en.NoWebView2=Microsoft Edge WebView2 Runtime is not installed. AutoSubtitle needs it to show its window.%n%nPlease install WebView2 (free, a 2 MB installer).%nOpen the download page now?
en.AskDeleteData=Also delete downloaded models, projects, glossary and settings?%n%nLocation: %1%n%nYour transcripts in Documents\AutoSubtitle are kept.

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
#ifexist "..\THIRD_PARTY_NOTICES.txt"
Source: "..\THIRD_PARTY_NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
#endif

[Icons]
Name: "{autoprograms}\AutoSubtitle 字幕工房"; Filename: "{app}\AutoSubtitle.exe"
Name: "{autodesktop}\AutoSubtitle 字幕工房"; Filename: "{app}\AutoSubtitle.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\AutoSubtitle.exe"; Description: "{cm:LaunchApp}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Key32 = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

function HasWebView2: Boolean;
var
  V: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, WebView2Key32, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ErrorCode: Integer;
begin
  if (CurStep = ssPostInstall) and (not WizardSilent) and (not HasWebView2) then
    if MsgBox(CustomMessage('NoWebView2'), mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', WebView2Url, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent) then
  begin
    DataDir := ExpandConstant('{userappdata}\AutoSubtitle');
    if DirExists(DataDir) then
      if MsgBox(FmtMessage(CustomMessage('AskDeleteData'), [DataDir]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
