pub fn is_valid_profile(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn is_valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with('-')
        && !branch.contains("..")
        && branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

pub fn is_valid_branch_prefix(prefix: &str) -> bool {
    !prefix.is_empty() && prefix.split('/').all(is_valid_ref_component)
}

fn is_valid_ref_component(part: &str) -> bool {
    !part.is_empty()
        && !part.starts_with('.')
        && !part.starts_with('-')
        && !part.ends_with('.')
        && !part.ends_with(".lock")
        && !part.contains("..")
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::is_valid_branch_prefix;

    #[test]
    fn accepts_plain_and_nested_prefixes() {
        for p in ["pico", "wt", "sen", "feature/x", "a-b_c.d", "team/sub/area"] {
            assert!(is_valid_branch_prefix(p), "{p} should be valid");
        }
    }

    #[test]
    fn rejects_git_breaking_prefixes() {
        for p in [
            "",
            ".foo",
            "foo.lock",
            "a//b",
            "foo/",
            "/foo",
            "foo.",
            "-foo",
            "a..b",
            "foo/.bar",
            "foo/bar.lock",
            "spa ce",
            "at@",
        ] {
            assert!(!is_valid_branch_prefix(p), "{p} should be rejected");
        }
    }
}
