#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::Command;

fn main() {
    // llama.cpp's bundled ggml-metal uses `@available(macOS ...)` checks, which
    // clang lowers to a `___isPlatformVersionAtLeast` call that lives in the
    // clang runtime (`libclang_rt.osx.a`). Rust final-links with
    // `-nodefaultlibs`, so compiler-rt is not pulled in automatically and the
    // symbol is undefined at link time (the aarch64 macOS release failed with
    // "Undefined symbols for architecture arm64: ___isPlatformVersionAtLeast").
    // Link the active toolchain's compiler-rt archive explicitly.
    #[cfg(target_os = "macos")]
    link_clang_compiler_rt();

    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn link_clang_compiler_rt() {
    let clang = std::env::var("CC").unwrap_or_else(|_| "clang".to_string());
    let Ok(output) = Command::new(&clang).arg("-print-resource-dir").output() else {
        println!(
            "cargo:warning=could not run `{clang} -print-resource-dir`; ggml Metal link may fail"
        );
        return;
    };
    if !output.status.success() {
        println!("cargo:warning=`{clang} -print-resource-dir` failed; ggml Metal link may fail");
        return;
    }
    let resource_dir = String::from_utf8_lossy(&output.stdout);
    let darwin_dir = Path::new(resource_dir.trim()).join("lib/darwin");
    let archive = darwin_dir.join("libclang_rt.osx.a");
    if archive.is_file() {
        println!("cargo:rustc-link-search=native={}", darwin_dir.display());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
        // Force-load so archive resolution order / dead_strip cannot drop it.
        println!("cargo:rustc-link-arg=-Wl,-force_load,{}", archive.display());
    } else {
        println!(
            "cargo:warning=libclang_rt.osx.a not found at {}; ggml Metal link may fail",
            archive.display()
        );
    }
}
