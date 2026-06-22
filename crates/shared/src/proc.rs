use tokio::process::Command;

fn render(cmd: &Command) -> String {
    let std = cmd.as_std();
    let mut parts = vec![std.get_program().to_string_lossy().into_owned()];
    parts.extend(std.get_args().map(|a| a.to_string_lossy().into_owned()));
    parts.join(" ")
}

pub async fn run(cmd: &mut Command) -> color_eyre::Result<String> {
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
