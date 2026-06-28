use std::path::Path;

use color_eyre::eyre::WrapErr;

pub fn read_secret(root: &Path, name: &str) -> color_eyre::Result<String> {
    let path = crate::paths::worker_secret(root, name);
    let raw = std::fs::read_to_string(&path).wrap_err_with(|| format!("read secret {}", path.display()))?;
    let value = raw.trim();
    if value.is_empty() {
        color_eyre::eyre::bail!("secret {} is empty", path.display());
    }
    Ok(value.to_owned())
}
