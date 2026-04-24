use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Try monorepo-relative path first, fall back to local copy (used by cross builds
    // where only the crate directory is mounted into the Docker container).
    let (proto_path, include_dir) = if PathBuf::from("../../proto/tapsmith.proto").exists() {
        (PathBuf::from("../../proto/tapsmith.proto"), "../../proto")
    } else if PathBuf::from("proto/tapsmith.proto").exists() {
        (PathBuf::from("proto/tapsmith.proto"), "proto")
    } else {
        panic!(
            "Proto file not found. Expected at ../../proto/tapsmith.proto (monorepo) or proto/tapsmith.proto (cross build)"
        );
    };

    let mut protos: Vec<PathBuf> = vec![proto_path.clone()];
    let mut includes: Vec<&str> = vec![include_dir];

    // The mitmproxy_ipc IPC proto is only needed on macOS (the ios_redirect
    // module that uses it is cfg-gated). Compiling it only when targeting
    // macOS keeps the Linux build surface minimal and avoids unused-code
    // warnings from generated types.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let vendored = PathBuf::from("vendor/mitmproxy_ipc.proto");
        if !vendored.exists() {
            panic!(
                "Vendored proto missing at {:?}. See vendor header for upstream source.",
                vendored
            );
        }
        protos.push(vendored);
        includes.push("vendor");
        println!("cargo:rerun-if-changed=vendor/mitmproxy_ipc.proto");
    }

    tonic_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(&protos, &includes)?;

    println!("cargo:rerun-if-changed={}", proto_path.display());

    Ok(())
}
