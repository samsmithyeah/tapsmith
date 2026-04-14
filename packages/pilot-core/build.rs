use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_path = PathBuf::from("../../proto/pilot.proto");

    if !proto_path.exists() {
        panic!(
            "Proto file not found at {:?}. Expected at ../../proto/pilot.proto relative to packages/pilot-core/",
            proto_path.canonicalize().unwrap_or(proto_path)
        );
    }

    let mut protos: Vec<PathBuf> = vec![proto_path];
    let mut includes: Vec<&str> = vec!["../../proto"];

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

    println!("cargo:rerun-if-changed=../../proto/pilot.proto");

    Ok(())
}
