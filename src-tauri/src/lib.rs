use std::process::Command;
use std::collections::HashMap;
use std::fs; 
use serde::{Deserialize, Serialize};
use tauri::{Window, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LogEntry {
    pub sender: String,
    pub message: String,
    pub priority: String,
    pub first_seen: String,
    pub last_seen: String,
    pub count: u32,
    pub history: Vec<String>,
    pub sys_id: String,
}

#[derive(Deserialize)]
struct RawJournalEntry {
    #[serde(rename = "SYSLOG_IDENTIFIER")] sender: Option<String>,
    #[serde(rename = "_PID")] pid: Option<String>,
    #[serde(rename = "MESSAGE")] message: Option<String>,
    #[serde(rename = "PRIORITY")] priority: Option<String>,
    #[serde(rename = "__REALTIME_TIMESTAMP")] timestamp: Option<String>,
}

// Strongly typed raw schema to guarantee error-free type conversion from PowerShell JSON output
#[derive(Deserialize, Debug)]
struct WinEventRaw {
    #[serde(rename = "ProviderName")] provider_name: Option<String>,
    #[serde(rename = "Message")] message: Option<String>,
    #[serde(rename = "Level")] level: Option<serde_json::Value>,
    #[serde(rename = "EventID")] event_id: Option<serde_json::Value>,
    #[serde(rename = "TimeCreated")] time_created: Option<serde_json::Value>,
}

#[tauri::command]
async fn fetch_deduplicated_logs(flags: String) -> Result<Vec<LogEntry>, String> {
    if cfg!(target_os = "windows") {
        fetch_windows_logs(flags)
    } else {
        fetch_linux_logs(flags)
    }
}

fn fetch_linux_logs(flags: String) -> Result<Vec<LogEntry>, String> {
    let mut args = vec!["-o", "json"];
    let user_args: Vec<&str> = flags.split_whitespace().collect();
    
    if !user_args.is_empty() {
        args.extend(user_args);
    } else {
        args.extend(["-n", "100"]);
    }

    let output = Command::new("journalctl").args(&args).output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut map = HashMap::new();

    for line in stdout.lines() {
        if let Ok(raw) = serde_json::from_str::<RawJournalEntry>(line) {
            let pid_val = raw.pid.unwrap_or_else(|| "N/A".to_string());
            process_entry(
                &mut map, 
                raw.sender.unwrap_or_else(|| "unknown".to_string()), 
                raw.message.unwrap_or_default(), 
                raw.priority.unwrap_or_else(|| "6".to_string()), 
                raw.timestamp.unwrap_or_else(|| "0".to_string()),
                pid_val
            );
        }
    }
    finalize_map(map)
}

fn fetch_windows_logs(flags: String) -> Result<Vec<LogEntry>, String> {
    let mut filter = String::from("@{LogName='System'; Level=1,2,3}");
    
    if !flags.trim().is_empty() && flags.contains('=') {
        let mut hash_parts = Vec::new();
        for pair in flags.split_whitespace() {
            if let Some((k, v)) = pair.split_once('=') {
                let kl = k.to_lowercase();
                if kl == "logname" || kl == "providername" {
                    hash_parts.push(format!("{}='{}'", k, v));
                } else { 
                    hash_parts.push(format!("{}={}", k, v)); 
                }
            }
        }
        if !hash_parts.is_empty() {
            filter = format!("@{{{}}}", hash_parts.join("; "));
        }
    }

    // Wrap script inside an explicit collection compiler array expression coercion loop @(...)
    let script = format!(
        "$res = Get-WinEvent -FilterHashtable {} -MaxEvents 150 -ErrorAction SilentlyContinue | Select-Object ProviderName, Message, Level, @{{Name='EventID';Expression={{ [string]$_.Id }} }}, @{{Name='TimeCreated';Expression={{ [int64]($_.TimeCreated.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds }} }}; if ($res) {{ @($res) | ConvertTo-Json -Depth 2 -Compress }} else {{ '[]' }}",
        filter
    );

    let output = Command::new("powershell")
        .args(["-Command", &script])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed_stdout = stdout.trim();
    
    if trimmed_stdout.is_empty() || trimmed_stdout == "[]" {
        return Ok(Vec::new());
    }

    // Handles safe type parsing fallback array mapping logic seamlessly
    let raw_entries: Vec<WinEventRaw> = if trimmed_stdout.starts_with('[') {
        serde_json::from_str(trimmed_stdout).unwrap_or_default()
    } else {
        // Fallback for standalone structural objects
        if let Ok(single) = serde_json::from_str::<WinEventRaw>(trimmed_stdout) {
            vec![single]
        } else {
            Vec::new()
        }
    };

    let mut map = HashMap::new();

    for entry in raw_entries {
        let sender = entry.provider_name.unwrap_or_else(|| "System".to_string());
        let message = entry.message.unwrap_or_default();
        let clean_msg = message.replace("\r\n", " ").replace('\n', " ").trim().to_string();
        
        // Dynamic string cast evaluation match routine
        let event_id = match entry.event_id {
            Some(serde_json::Value::String(s)) => s,
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => "0".to_string(),
        };

        let level = match entry.level {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s,
            _ => "3".to_string(),
        };

        let ts = match entry.time_created {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s,
            _ => "0".to_string(),
        };

        process_entry(&mut map, sender, clean_msg, level, ts, event_id);
    }

    finalize_map(map)
}

fn process_entry(map: &mut HashMap<String, LogEntry>, sender: String, message: String, priority: String, ts: String, sys_id: String) {
    let key = format!("{}-{}-{}", sender, message, sys_id);
    let entry = map.entry(key).or_insert_with(|| LogEntry {
        sender, message, priority,
        first_seen: ts.clone(), last_seen: ts.clone(),
        count: 0, history: Vec::new(), sys_id
    });
    entry.count += 1;
    entry.last_seen = ts;
    entry.history.push(entry.last_seen.clone());
}

fn finalize_map(map: HashMap<String, LogEntry>) -> Result<Vec<LogEntry>, String> {
    let mut result: Vec<LogEntry> = map.into_values().collect();
    result.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    Ok(result)
}

#[tauri::command]
fn start_live_watch(window: Window) {
    std::thread::spawn(move || loop {
        let _ = window.emit("new-log-event", ());
        std::thread::sleep(std::time::Duration::from_secs(5));
    });
}

#[tauri::command]
fn open_link(url: String) {
    #[cfg(target_os = "windows")]
    let _ = Command::new("cmd").args(["/C", "start", "", &url]).spawn();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(&url).spawn();
}

#[tauri::command]
async fn save_logs_to_file(window: Window, json_data: String) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    
    if let Some(path) = window.dialog().file().add_filter("JSON", &["json"]).set_title("Export Logs").blocking_save_file() {
        let path_str = path.to_string();
        let clean_path = path_str.trim_start_matches("file:///").trim_start_matches("file://");
        fs::write(clean_path, json_data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fetch_deduplicated_logs, start_live_watch, open_link, save_logs_to_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}