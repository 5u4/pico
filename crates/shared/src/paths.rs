use std::path::PathBuf;

/// `~/.pico` — the root every supervisor and worker directory hangs off.
///
/// Errors if the home directory can't be resolved.
pub fn pico_home() -> color_eyre::Result<PathBuf> {
    let home = std::env::home_dir().ok_or_else(|| color_eyre::eyre::eyre!("cannot determine home directory"))?;
    Ok(home.join(".pico"))
}
