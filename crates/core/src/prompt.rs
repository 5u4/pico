//! pico's base system prompt: embedded, rewritten to the worker root at startup,
//! then passed to every `omp` child via `--system-prompt` to override omp's block 0.
//! omp still re-renders the `.omp/rules`/skills/footer beneath it; `identity.md` appends next.

use std::path::{Path, PathBuf};

use color_eyre::eyre::WrapErr;

const BASE_SYSTEM_PROMPT: &str = include_str!("system_prompt.md");

/// Write the embedded base prompt to `<root>/system_prompt.md` (overwrites, tracking the binary).
pub fn write_base_prompt(root: &Path) -> color_eyre::Result<PathBuf> {
    let path = pico_shared::paths::base_prompt(root);
    std::fs::write(&path, BASE_SYSTEM_PROMPT).wrap_err_with(|| format!("write {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_base_prompt_round_trips_embedded_source() {
        let root = std::env::temp_dir().join(format!("pico-base-prompt-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let path = write_base_prompt(&root).expect("write base prompt");
        assert_eq!(path, pico_shared::paths::base_prompt(&root));
        assert_eq!(std::fs::read_to_string(&path).expect("read back"), BASE_SYSTEM_PROMPT);
        std::fs::remove_dir_all(&root).ok();
    }
}
