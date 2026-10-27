## 本版更新 What's new

- **模型管理頁**：下載進度、速度、剩餘時間，可取消、可續傳、可刪除；第一次用模型會先詢問。
  **Models page**: download progress, speed and ETA, cancel, resume and delete; the app asks before the first download.
- **轉檔進度分四階段**：下載、讀取音訊、載入模型、辨識，每個階段都能取消，並顯示剩餘時間。
  **Four-stage progress** (download, read audio, load model, transcribe), cancellable at every stage, with ETA.
- **Windows 安裝程式**：不需管理員權限、開始功能表捷徑、可從設定解除安裝。
  **Windows installer**: no admin rights, Start menu shortcut, uninstall from Settings.
- **更新檢查與關於頁**、紀錄檔、第三方授權清單、SHA256 校驗檔。
  **Update check and About panel**, log files, third-party notices, SHA256 checksums.
- 辨識引擎：詞庫改用 hotwords（長詞庫不再失效）、新增 large-v3-turbo 模型。
  Engine: glossary now uses hotwords (long glossaries no longer drop out), added large-v3-turbo.
- 修正：改字後立刻點別句會遺失輸入、搜尋狀態下 Tab 鎖死快捷鍵、轉檔頁誤觸編輯器快捷鍵。
  Fixes: lost edits when clicking another line right after editing, Tab locking hotkeys while filtering, editor hotkeys firing on the transcript page.

## 下載 Download

| 系統 System | 建議 Recommended | 免安裝 Portable |
|---|---|---|
| Windows 10/11 | `AutoSubtitle-*-Windows-Setup.exe` | `AutoSubtitle-*-Windows.zip` |
| Windows + NVIDIA 顯示卡 GPU | `AutoSubtitle-*-Windows-NVIDIA-GPU-Setup.exe`（內含 CUDA 函式庫，檔案較大 / bundles CUDA, larger） | `AutoSubtitle-*-Windows-NVIDIA-GPU.zip` |
| Mac（M1、M2、M3、M4…） | `AutoSubtitle-*-macOS-Apple-Silicon.dmg` | |
| Mac（Intel） | `AutoSubtitle-*-macOS-Intel.dmg` | |

`SHA256SUMS.txt` 可用來確認下載的檔案完整。Use `SHA256SUMS.txt` to verify your download.

### Windows

1. 執行 `Setup.exe`。不需要系統管理員權限，會裝到你自己的使用者資料夾，並建立開始功能表捷徑。
   Run `Setup.exe`. No admin rights needed. It installs to your user folder and adds a Start menu shortcut.
2. 第一次執行若出現「Windows 已保護您的電腦」，按「其他資訊」→「仍要執行」。這是因為程式還沒有程式碼簽章。
   If SmartScreen appears, choose **More info → Run anyway**. The app is not code-signed yet.
3. 解除安裝：「設定 → 應用程式」找到 AutoSubtitle。會問你要不要一併刪除模型與設定，逐字稿不會被刪。
   Uninstall from **Settings → Apps**. It asks whether to delete models and settings; transcripts are kept.

免安裝版：解壓 zip 後打開 `AutoSubtitle.exe`。Portable: extract the zip and open `AutoSubtitle.exe`.

### macOS

1. 打開 dmg，把 AutoSubtitle 拖到「應用程式」。
   Open the dmg and drag AutoSubtitle into Applications.
2. 第一次開啟若提示無法驗證開發者：到「系統設定 → 隱私權與安全性」按「強制打開」。或在終端機執行：
   If macOS says it can't verify the developer, go to **System Settings → Privacy & Security → Open Anyway**, or run:
   ```
   xattr -dr com.apple.quarantine /Applications/AutoSubtitle.app
   ```

### 第一次使用 First run

- 第一次用某個模型要先下載（「標準」約 486 MB），介面會先詢問並顯示進度，之後可離線使用。也可以在側欄「模型」頁預先下載。
  Each model downloads once (the standard model is about 486 MB). The app asks first and shows progress. You can also pre-download from the **Models** page.
- 逐字稿預設存到「文件 / AutoSubtitle」。Transcripts are saved to **Documents/AutoSubtitle**.
