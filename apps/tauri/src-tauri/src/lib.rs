//! The desktop shell owns profiles and the SSH process only. Git and cbranch RPC
//! remain remote-server responsibilities; no repository operation runs here.

use std::{
    collections::VecDeque,
    fs,
    io::{self, Read},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, State};

const PROFILE_STORE_VERSION: u32 = 1;
const PROFILE_STORE_FILE: &str = "profiles.json";
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const STDERR_LIMIT: u64 = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    id: String,
    name: String,
    host: String,
    user: String,
    ssh_port: u16,
    remote_port: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    id: Option<String>,
    name: String,
    host: String,
    user: String,
    ssh_port: u16,
    remote_port: u16,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileStore {
    version: u32,
    profiles: Vec<ConnectionProfile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConnection {
    profile_id: String,
    rpc_url: String,
    http_base_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDiagnostics {
    desktop_version: String,
    profile: Option<ConnectionProfile>,
    tunnel_state: String,
    endpoint: Option<String>,
    recent_errors: Vec<String>,
}

struct TunnelProcess {
    child: Child,
    stderr: thread::JoinHandle<String>,
    connection: TunnelConnection,
}

struct TunnelStop {
    stderr: String,
    #[cfg(test)]
    reaped: bool,
}

impl TunnelProcess {
    fn stop(mut self) -> TunnelStop {
        // `ssh` is the only child we spawn. Killing this handle never touches an
        // existing user tunnel or another application process.
        let _ = self.child.kill();
        #[cfg(test)]
        let reaped = self.child.wait().is_ok();
        #[cfg(not(test))]
        let _ = self.child.wait();
        TunnelStop {
            stderr: self.stderr.join().unwrap_or_default(),
            #[cfg(test)]
            reaped,
        }
    }
}

#[derive(Default)]
struct TunnelRegistry {
    active: Option<TunnelProcess>,
}

impl TunnelRegistry {
    fn replace(&mut self, next: TunnelProcess) -> Option<TunnelProcess> {
        self.active.replace(next)
    }

    fn clear(&mut self) -> Option<TunnelProcess> {
        self.active.take()
    }
}

#[derive(Default)]
struct DesktopState {
    tunnel: TunnelRegistry,
    selected_profile: Option<ConnectionProfile>,
    recent_errors: VecDeque<String>,
}

impl DesktopState {
    fn record_error(&mut self, error: impl AsRef<str>) {
        self.recent_errors.push_back(redact(error.as_ref()));
        while self.recent_errors.len() > 20 {
            self.recent_errors.pop_front();
        }
    }

    fn disconnect(&mut self) {
        if let Some(tunnel) = self.tunnel.clear() {
            let stopped = tunnel.stop();
            let stderr = stopped.stderr;
            if !stderr.trim().is_empty() {
                self.record_error(stderr);
            }
        }
        self.selected_profile = None;
    }
}

pub struct AppState(Mutex<DesktopState>);

impl Default for AppState {
    fn default() -> Self {
        Self(Mutex::new(DesktopState::default()))
    }
}

fn lock_state<'a>(state: &'a State<'a, AppState>) -> Result<MutexGuard<'a, DesktopState>, String> {
    state
        .0
        .lock()
        .map_err(|_| "The desktop connection state is unavailable. Restart cbranch.".to_string())
}

fn profile_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|error| {
        format!("Could not resolve the desktop configuration directory: {error}")
    })?;
    Ok(dir.join(PROFILE_STORE_FILE))
}

fn load_store(app: &AppHandle) -> Result<ProfileStore, String> {
    let path = profile_store_path(app)?;
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(ProfileStore::default()),
        Err(error) => return Err(format!("Could not read connection profiles: {error}")),
    };
    let store: ProfileStore = serde_json::from_str(&contents)
        .map_err(|_| "Connection profiles are unreadable. Move profiles.json aside and recreate the profiles.".to_string())?;
    if store.version != 0 && store.version != PROFILE_STORE_VERSION {
        return Err(
            "Connection profiles use a newer unsupported format. Update cbranch desktop."
                .to_string(),
        );
    }
    Ok(store)
}

fn save_store(app: &AppHandle, store: &ProfileStore) -> Result<(), String> {
    let path = profile_store_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve the connection profile directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the connection profile directory: {error}"))?;
    let serialized = serde_json::to_string_pretty(store)
        .map_err(|error| format!("Could not encode connection profiles: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serialized)
        .map_err(|error| format!("Could not write connection profiles: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not save connection profiles: {error}"))
}

fn has_only(value: &str, allowed: impl Fn(char) -> bool) -> bool {
    !value.is_empty() && value.chars().all(allowed)
}

fn validate_profile(profile: &ConnectionProfile) -> Result<(), String> {
    if profile.name.trim().is_empty()
        || profile.name.len() > 80
        || profile.name.chars().any(char::is_control)
    {
        return Err("Profile name must be 1-80 printable characters.".to_string());
    }
    if !has_only(&profile.user, |character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
    }) || profile.user.starts_with('-')
    {
        return Err("SSH user may contain only letters, numbers, '.', '_' and '-'.".to_string());
    }
    if !has_only(&profile.host, |character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | ':')
    }) || profile.host.starts_with('-')
    {
        return Err("SSH host may contain only letters, numbers, '.', '-' and ':'. Use an SSH config alias for other host syntax.".to_string());
    }
    if profile.ssh_port == 0 || profile.remote_port == 0 {
        return Err("SSH and remote cbranch ports must be between 1 and 65535.".to_string());
    }
    Ok(())
}

fn profile_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("profile-{nanos:x}")
}

fn ssh_arguments(profile: &ConnectionProfile, local_port: u16) -> Vec<String> {
    vec![
        "-N".to_string(),
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-o".to_string(),
        "ExitOnForwardFailure=yes".to_string(),
        "-p".to_string(),
        profile.ssh_port.to_string(),
        "-L".to_string(),
        format!("127.0.0.1:{local_port}:127.0.0.1:{}", profile.remote_port),
        format!("{}@{}", profile.user, profile.host),
    ]
}

fn ssh_diagnostic_command(profile: &ConnectionProfile, local_port: u16) -> String {
    format!("ssh {}", ssh_arguments(profile, local_port).join(" "))
}

fn spawn_stderr_reader(stderr: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut text = String::new();
        let mut reader = stderr.take(STDERR_LIMIT);
        let _ = reader.read_to_string(&mut text);
        redact(&text)
    })
}

fn start_tunnel(profile: &ConnectionProfile) -> Result<TunnelProcess, String> {
    validate_profile(profile)?;
    // Reserve the loopback port while building the child process. SSH receives the
    // selected port as an argument and only ever binds 127.0.0.1; a retry is required
    // if another process wins the short handoff between releasing the reservation and SSH.
    let reservation = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not reserve a local loopback port: {error}"))?;
    let local_port = reservation
        .local_addr()
        .map_err(|error| format!("Could not inspect the reserved loopback port: {error}"))?
        .port();
    let args = ssh_arguments(profile, local_port);
    let mut child = Command::new("ssh")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                "OpenSSH (ssh) was not found. Install an OpenSSH client and retry."
                    .to_string()
            } else {
                format!("Could not start OpenSSH: {error}")
            }
        })?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "OpenSSH did not provide diagnostics.".to_string())?;
    let stderr = spawn_stderr_reader(stderr);
    drop(reservation);

    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not monitor OpenSSH: {error}"))?
        {
            let stderr = stderr.join().unwrap_or_default();
            return Err(classify_ssh_failure(status.code(), &stderr));
        }
        if TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], local_port)),
            Duration::from_millis(150),
        )
        .is_ok()
        {
            let base = format!("http://127.0.0.1:{local_port}");
            return Ok(TunnelProcess {
                child,
                stderr,
                connection: TunnelConnection {
                    profile_id: profile.id.clone(),
                    rpc_url: format!("ws://127.0.0.1:{local_port}/rpc"),
                    http_base_url: base,
                },
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let stderr = stderr.join().unwrap_or_default();
            return Err(format!(
                "The SSH tunnel did not become ready. Verify SSH access and that cbranch listens on 127.0.0.1:{} on the remote host. {}",
                profile.remote_port,
                stderr
            ));
        }
        thread::sleep(Duration::from_millis(75));
    }
}

fn classify_ssh_failure(exit_code: Option<i32>, stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    let explanation = if lower.contains("host key verification failed") {
        "Host-key verification failed. Verify the host key with a normal ssh command, then retry."
    } else if lower.contains("permission denied") || lower.contains("publickey") {
        "SSH authentication failed. Load the correct key into your agent or update your SSH configuration."
    } else if lower.contains("connection refused")
        || lower.contains("could not resolve hostname")
        || lower.contains("connection timed out")
    {
        "SSH could not reach the configured host or port. Check the profile and network connection."
    } else if lower.contains("address already in use") {
        "SSH could not bind the local tunnel port. Retry to select a new loopback port."
    } else {
        "SSH exited before the tunnel was ready."
    };
    let details = stderr.trim();
    if details.is_empty() {
        format!("{explanation} (exit code: {}).", exit_code.unwrap_or(-1))
    } else {
        format!("{explanation} {details}")
    }
}

fn redact(text: &str) -> String {
    let mut redacted = text.to_string();
    // Redact password/token query values and URL userinfo before keeping diagnostics.
    for key in ["password=", "token=", "secret="] {
        redacted = redact_assignment(&redacted, key);
    }
    if let Some(scheme) = redacted.find("://") {
        let credentials_start = scheme + 3;
        let remaining = &redacted[credentials_start..];
        if let Some(at_offset) = remaining.find('@') {
            let at = credentials_start + at_offset;
            let credentials = &redacted[credentials_start..at];
            if let Some(colon_offset) = credentials.find(':') {
                let secret_start = credentials_start + colon_offset + 1;
                redacted.replace_range(secret_start..at, "[redacted]");
            }
        }
    }
    redacted
}

fn redact_assignment(text: &str, key: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut redacted = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find(key) {
        let value_start = cursor + found + key.len();
        let value_end = text[value_start..]
            .find(|character: char| character.is_whitespace() || character == '&')
            .map(|offset| value_start + offset)
            .unwrap_or(text.len());
        redacted.push_str(&text[cursor..value_start]);
        redacted.push_str("[redacted]");
        cursor = value_end;
    }
    redacted.push_str(&text[cursor..]);
    redacted
}

fn profile_by_id(app: &AppHandle, id: &str) -> Result<ConnectionProfile, String> {
    load_store(app)?
        .profiles
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "The selected connection profile no longer exists.".to_string())
}

#[tauri::command]
fn list_profiles(app: AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    Ok(load_store(&app)?.profiles)
}

#[tauri::command]
fn save_profile(app: AppHandle, profile: ProfileInput) -> Result<ConnectionProfile, String> {
    let mut store = load_store(&app)?;
    let saved = ConnectionProfile {
        id: profile.id.unwrap_or_else(profile_id),
        name: profile.name.trim().to_string(),
        host: profile.host.trim().to_string(),
        user: profile.user.trim().to_string(),
        ssh_port: profile.ssh_port,
        remote_port: profile.remote_port,
    };
    validate_profile(&saved)?;
    if let Some(index) = store.profiles.iter().position(|item| item.id == saved.id) {
        store.profiles[index] = saved.clone();
    } else {
        store.profiles.push(saved.clone());
    }
    store.version = PROFILE_STORE_VERSION;
    save_store(&app, &store)?;
    Ok(saved)
}

#[tauri::command]
fn delete_profile(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut store = load_store(&app)?;
    let before = store.profiles.len();
    store.profiles.retain(|profile| profile.id != id);
    if before == store.profiles.len() {
        return Err("The selected connection profile no longer exists.".to_string());
    }
    save_store(&app, &store)?;
    let mut state = lock_state(&state)?;
    if state
        .selected_profile
        .as_ref()
        .is_some_and(|profile| profile.id == id)
    {
        state.disconnect();
    }
    Ok(())
}

#[tauri::command]
fn test_profile(app: AppHandle, id: String) -> Result<String, String> {
    let profile = profile_by_id(&app, &id)?;
    let tunnel = start_tunnel(&profile)?;
    let endpoint = tunnel.connection.http_base_url.clone();
    let stderr = tunnel.stop().stderr;
    let suffix = if stderr.trim().is_empty() {
        String::new()
    } else {
        format!(" {stderr}")
    };
    Ok(format!("Tunnel established at {endpoint}.{suffix}"))
}

#[tauri::command]
fn connect_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<TunnelConnection, String> {
    let profile = profile_by_id(&app, &id)?;
    let tunnel = match start_tunnel(&profile) {
        Ok(tunnel) => tunnel,
        Err(error) => {
            let mut state = lock_state(&state)?;
            state.record_error(&error);
            return Err(error);
        }
    };
    let connection = tunnel.connection.clone();
    let mut state = lock_state(&state)?;
    if let Some(previous) = state.tunnel.replace(tunnel) {
        let stderr = previous.stop().stderr;
        if !stderr.trim().is_empty() {
            state.record_error(stderr);
        }
    }
    state.selected_profile = Some(profile);
    Ok(connection)
}

#[tauri::command]
fn disconnect_tunnel(state: State<'_, AppState>) -> Result<(), String> {
    lock_state(&state)?.disconnect();
    Ok(())
}

#[tauri::command]
fn diagnostic_command(app: AppHandle, id: String) -> Result<String, String> {
    let profile = profile_by_id(&app, &id)?;
    Ok(ssh_diagnostic_command(&profile, 7421))
}

#[tauri::command]
fn desktop_diagnostics(state: State<'_, AppState>) -> Result<DesktopDiagnostics, String> {
    let state = lock_state(&state)?;
    Ok(DesktopDiagnostics {
        desktop_version: env!("CARGO_PKG_VERSION").to_string(),
        profile: state.selected_profile.clone(),
        tunnel_state: if state.tunnel.active.is_some() {
            "connected".to_string()
        } else {
            "disconnected".to_string()
        },
        endpoint: state
            .tunnel
            .active
            .as_ref()
            .map(|tunnel| tunnel.connection.http_base_url.clone()),
        recent_errors: state.recent_errors.iter().cloned().collect(),
    })
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            save_profile,
            delete_profile,
            test_profile,
            connect_profile,
            disconnect_tunnel,
            diagnostic_command,
            desktop_diagnostics,
        ])
        .build(tauri::generate_context!())
        .expect("error while building cbranch desktop");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            let state = app_handle.state::<AppState>();
            if let Ok(mut state) = state.0.lock() {
                state.disconnect();
            };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: "profile-1".to_string(),
            name: "Production".to_string(),
            host: "git.example.com".to_string(),
            user: "serge".to_string(),
            ssh_port: 2222,
            remote_port: 7420,
        }
    }

    #[test]
    fn validates_a_non_secret_ssh_profile() {
        assert!(validate_profile(&profile()).is_ok());
        let mut unsafe_profile = profile();
        unsafe_profile.host = "-oProxyCommand=evil".to_string();
        assert!(validate_profile(&unsafe_profile).is_err());
    }

    #[test]
    fn builds_strict_argument_vector_without_a_shell() {
        assert_eq!(
            ssh_arguments(&profile(), 51234),
            [
                "-N",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-p",
                "2222",
                "-L",
                "127.0.0.1:51234:127.0.0.1:7420",
                "serge@git.example.com",
            ]
            .map(String::from)
            .to_vec()
        );
    }

    #[test]
    fn registry_replaces_and_clears_only_the_owned_tunnel_slot() {
        let mut registry = TunnelRegistry::default();
        assert!(registry.replace(test_tunnel("first")).is_none());
        let replaced = registry
            .replace(test_tunnel("second"))
            .expect("the first app-owned child must be returned for cleanup");
        assert!(replaced.stop().reaped);
        let disconnected = registry
            .clear()
            .expect("the replacement child must remain owned until disconnect");
        assert!(disconnected.stop().reaped);
    }

    #[test]
    fn redacts_url_and_key_value_secrets() {
        let value = redact("https://alice:supersecret@example.test password=supersecret token=abc");
        assert!(!value.contains("supersecret"));
        assert!(!value.contains("token=abc"));
    }

    fn test_tunnel(profile_id: &str) -> TunnelProcess {
        let executable = std::env::current_exe().expect("test executable path");
        let mut child = Command::new(executable)
            .args(["--exact", "tests::cleanup_helper", "--ignored"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("controlled child process");
        let stderr = spawn_stderr_reader(child.stderr.take().expect("child stderr"));
        TunnelProcess {
            child,
            stderr,
            connection: TunnelConnection {
                profile_id: profile_id.to_string(),
                rpc_url: "ws://127.0.0.1:1/rpc".to_string(),
                http_base_url: "http://127.0.0.1:1".to_string(),
            },
        }
    }

    #[test]
    #[ignore]
    fn cleanup_helper() {
        thread::sleep(Duration::from_secs(60));
    }
}
