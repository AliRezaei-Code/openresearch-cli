#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[tokio::main]
async fn main() {
    #[cfg(unix)]
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--print-environment")
    {
        openresearch_cli::desktop::print_environment();
        return;
    }

    if let Err(error) = openresearch_cli::desktop::launch().await {
        eprintln!("OpenResearch: {error:#}");
        openresearch_cli::desktop::show_error(&error.to_string());
        std::process::exit(1);
    }
}
