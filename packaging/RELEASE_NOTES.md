## 下載 Download

| 系統 System | 檔案 File |
|---|---|
| Windows 10/11 | `AutoSubtitle-*-Windows.zip` |
| Windows + NVIDIA 顯示卡 GPU | `AutoSubtitle-*-Windows-NVIDIA-GPU.zip`（內含 CUDA 函式庫，檔案較大 / bundles CUDA libraries, larger） |
| Mac（M1、M2、M3、M4…） | `AutoSubtitle-*-macOS-Apple-Silicon.dmg` |
| Mac（Intel） | `AutoSubtitle-*-macOS-Intel.dmg` |

### Windows

1. 下載 zip 並解壓縮，打開資料夾裡的 `AutoSubtitle.exe`。
   Download the zip, extract it, and open `AutoSubtitle.exe`.
2. 第一次開啟若出現「Windows 已保護您的電腦」，按「其他資訊」→「仍要執行」。這是因為程式沒有購買程式碼簽章。
   If SmartScreen appears, choose **More info → Run anyway**. The app is not code-signed.

### macOS

1. 打開 dmg，把 AutoSubtitle 拖到「應用程式」。
   Open the dmg and drag AutoSubtitle into Applications.
2. 第一次開啟若提示無法驗證開發者：到「系統設定 → 隱私權與安全性」按「強制打開」。或在終端機執行：
   If macOS says it can't verify the developer, go to **System Settings → Privacy & Security → Open Anyway**, or run:
   ```
   xattr -dr com.apple.quarantine /Applications/AutoSubtitle.app
   ```

### 第一次使用 First run

- 第一次用某個模型會先下載模型檔（small 約 484 MB），需要網路，之後可離線使用。
  The first use of each model downloads it once (small is about 484 MB). After that it works offline.
- 逐字稿預設存到「文件 / AutoSubtitle」。Transcripts are saved to **Documents/AutoSubtitle** by default.
