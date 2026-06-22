use std::path::{Path, PathBuf};

use color_eyre::eyre::WrapErr;

const APPEND_DELTA: &str = include_str!("append_prompt.md");

pub fn assemble_append(dest: &Path, identity: Option<&Path>) -> color_eyre::Result<PathBuf> {
    let mut body = APPEND_DELTA.to_string();
    if let Some(identity) = identity {
        match std::fs::read_to_string(identity) {
            Ok(soul) => {
                body.push_str("\n\n");
                body.push_str(&soul);
            }
            Err(e) => {
                tracing::warn!(path = %identity.display(), error = %e, "reading identity.md failed; using delta only")
            }
        }
    }
    let dir = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir).wrap_err_with(|| format!("create {}", dir.display()))?;
    let tmp = dir.join(format!(".append.{}.tmp", ulid::Ulid::new()));
    std::fs::write(&tmp, &body).wrap_err_with(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, dest).wrap_err_with(|| format!("rename {} -> {}", tmp.display(), dest.display()))?;
    Ok(dest.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pico-append-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn assemble_append_delta_only_when_no_identity() {
        let dir = tmp();
        let dest = dir.join("append.md");
        let path = assemble_append(&dest, None).expect("assemble");
        assert_eq!(path, dest);
        assert_eq!(std::fs::read_to_string(&dest).expect("read"), APPEND_DELTA);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn assemble_append_concatenates_identity_after_delta() {
        let dir = tmp();
        let identity = dir.join("identity.md");
        std::fs::write(&identity, "You are a witty pirate.").expect("write identity");
        let dest = dir.join("append.md");
        assemble_append(&dest, Some(&identity)).expect("assemble");
        let out = std::fs::read_to_string(&dest).expect("read");
        assert!(out.starts_with(APPEND_DELTA), "delta must come first");
        assert!(out.contains("You are a witty pirate."), "identity must be included");
        std::fs::remove_dir_all(&dir).ok();
    }
}
