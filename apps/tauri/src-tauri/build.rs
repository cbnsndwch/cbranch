fn main() {
    println!("cargo:rerun-if-env-changed=CBRANCH_SERVER_VARIANT");
    let icon = if std::env::var("CBRANCH_SERVER_VARIANT").as_deref() == Ok("canary") {
        "icons/canary/icon.ico"
    } else {
        "icons/icon.ico"
    };
    let attributes = tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new().window_icon_path(icon),
    );
    tauri_build::try_build(attributes).expect("failed to build Tauri application")
}
