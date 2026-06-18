# LuxLite Diagnostics (Beta Release)

LuxLite Diagnostics is a high-performance, cross-platform log management, deduplication, and metrics charting application built with Tauri v2 and Rust. 

This beta build is pre-compiled and fully standalone. You do not need to install Rust, Node.js, or any background developer dependencies to run it.

---

## 🚀 Downloading & Running the Executable

### 🪟 Windows Setup
1. Go to the **Releases** tab on GitHub and download `LuxLite_Diagnostics_x64.exe` (or the `.msi` installer).
2. Double-click the executable to launch.
3. *Note on Windows SmartScreen:* Because this is an unsigned beta package, Windows Defender may show a protective popup saying *"Windows protected your PC"*. Click **"More Info"** and then select **"Run Anyway"** to launch the console.

### 🐧 Linux Setup
1. Download the `LuxLite_Diagnostics_amd64.deb` package (for Debian/Ubuntu) or the standalone `.AppImage`.
2. If using the AppImage, open your terminal and grant it execution permissions before running:
   ```bash
   chmod +x LuxLite_Diagnostics.AppImage
   ./LuxLite_Diagnostics.AppImage
   ```

---

## ⚙️ Advanced Mode Flag Engine

When you turn on **Advanced Mode**, the visual configurations (Log Source dropdown, Severity checkboxes, and Max Limit inputs) are bound into a unified key-value parameter payload string. 

You can manually edit this line or type standard CLI-style parameter pairs directly into the advanced terminal pipeline console. Pressing `Enter` bypasses visual abstractions and pipes your instructions straight to the native host machine shells.

### Parameter Reference

| Key | Supported Values | Platform Mapping | Description |
| :--- | :--- | :--- | :--- |
| `LogName` | `System`, `Application`, `Security`, or custom | **Windows**: `-FilterHashtable` target <br>**Linux**: Positional `journalctl` ID match | Defines the specific event subsystem or provider namespace to pool logs from. |
| `Level` | Commas-separated integers (e.g., `1,2,3`) | **Windows**: Native Event levels <br>**Linux**: Fallback prioritized matching | Filters records strictly matching specific logging severities. |
| `MaxEntries` | Numbers `1` through `1000` | **Windows**: `-MaxEvents`<br>**Linux**: `-n` [limit] flag | Sets the absolute hard upper ceiling of structural logs to parse. |

---

### Platform-Specific Execution Architecture

Because Windows and Linux record system events via completely different mechanisms, the core Rust layer dynamically unrolls your advanced parameter string into separate system targets:

#### 🪟 Windows Pipeline Execution
On Windows, your flags are extracted and rebuilt as an atomic **PowerShell FilterHashtable** before passing over the process matrix. This bypasses slow pipeline text formatting and performs the filtering at the kernel level.

* **Under the Hood Command:**
  ```powershell
  Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2,3} -MaxEvents 150
  ```
* **Advanced Field Example:** To pull only the last 50 fatal Application logs via the Advanced input field:
  ```text
  LogName=Application Level=2 MaxEntries=50
  ```

#### 🐧 Linux Pipeline Execution
On Linux platforms, the Rust layer intercepts the platform-agnostic token mappings and rewrites them into structured terminal arguments optimized directly for the system **Systemd Journal Engine (`journalctl`)**.

* **Under the Hood Command:**
  ```bash
  journalctl -o json -n 150 System
  ```
* **Advanced Field Example:** To isolate system journal traces originating from a specific target identifier namespace:
  ```text
  LogName=sshd MaxEntries=250
  ```

---

## 🛠️ Beta Features Included

* **Unified Log Deduplication**: Algorithms merge identical high-frequency log lines on the fly, tracking their `first_seen` / `last_seen` lifetimes alongside exact occurrence hit-counts.
* **Stream Pulse Charting**: Real-time canvas gradient lines detailing log frequencies over rolling chronological minute buckets.
* **Contextual Investigator**: Clicking any log row provides a rich metadata display, an active instance history index, and an automated solution locator bridging directly to documentation queries.
* **Air-Gapped Log Interoperability**: Fully supports exporting runtime views to a decoupled, portable JSON structure or re-importing snapshots directly into the visual interface on any isolated machine.
