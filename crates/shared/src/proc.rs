use tokio::process::Command;

/// Render a command as `program arg1 arg2` for logs and error messages.
fn render(cmd: &Command) -> String {
    let std = cmd.as_std();
    let mut parts = vec![std.get_program().to_string_lossy().into_owned()];
    parts.extend(std.get_args().map(|a| a.to_string_lossy().into_owned()));
    parts.join(" ")
}

/// Run `cmd` to completion, discarding its output. Errors on a non-zero exit;
/// the full stderr is logged at `warn` and the command + status go into the
/// returned error.
pub async fn run(cmd: &mut Command) -> color_eyre::Result<()> {
    run_capture(cmd).await.map(drop)
}

/// Like [`run`] but returns the command's trimmed stdout on success.
pub async fn run_capture(cmd: &mut Command) -> color_eyre::Result<String> {
    let rendered = render(cmd);
    tracing::debug!(command = %rendered, "running command");

    let output = cmd
        .output()
        .await
        .map_err(|e| color_eyre::eyre::eyre!("spawn `{rendered}`: {e}"))?;

    if !output.status.success() {
        tracing::warn!(
            command = %rendered,
            status = %output.status,
            "command failed:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        color_eyre::eyre::bail!("`{rendered}` failed ({})", output.status);
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
