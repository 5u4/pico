use std::{borrow::Cow, sync::LazyLock};

use regex::Regex;

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let compile = |pattern: &str| Regex::new(pattern).expect("valid redaction pattern");
    vec![
        (
            compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
            "[REDACTED PRIVATE KEY]",
        ),
        (compile(r"github_pat_[A-Za-z0-9_]{20,}"), "[REDACTED]"),
        (compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED]"),
        (compile(r"sk-ant-[A-Za-z0-9_-]{20,}"), "[REDACTED]"),
        (compile(r"sk-[A-Za-z0-9_-]{20,}"), "[REDACTED]"),
        (compile(r"AKIA[0-9A-Z]{16}"), "[REDACTED]"),
        (compile(r"AIza[0-9A-Za-z_-]{35}"), "[REDACTED]"),
        (compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "[REDACTED]"),
        (
            compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
            "[REDACTED]",
        ),
        (compile(r"(?i)bearer\s+[A-Za-z0-9._~+/-]{16,}=*"), "Bearer [REDACTED]"),
    ]
});

pub fn scrub(input: &str) -> Cow<'_, str> {
    let mut current = Cow::Borrowed(input);
    for (re, replacement) in PATTERNS.iter() {
        if let Cow::Owned(replaced) = re.replace_all(current.as_ref(), *replacement) {
            current = Cow::Owned(replaced);
        }
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_github_token() {
        let out = scrub("token ghp_16C7e42F292c6912E7710c838347Ae178B4a here");
        assert_eq!(out, "token [REDACTED] here");
    }

    #[test]
    fn redacts_github_fine_grained_pat() {
        let out = scrub("pat github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwx1234567890 done");
        assert_eq!(out, "pat [REDACTED] done");
    }

    #[test]
    fn redacts_openai_key() {
        let out = scrub("key sk-abcdefghijklmnopqrstuvwxyz0123 end");
        assert_eq!(out, "key [REDACTED] end");
    }

    #[test]
    fn redacts_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        let input = format!("here is {jwt} ok");
        let out = scrub(&input);
        assert_eq!(out, "here is [REDACTED] ok");
    }

    #[test]
    fn redacts_pem_private_key_block() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabcd/efgh+1234\n-----END RSA PRIVATE KEY-----";
        let input = format!("before\n{pem}\nafter");
        let out = scrub(&input);
        assert_eq!(out, "before\n[REDACTED PRIVATE KEY]\nafter");
    }

    #[test]
    fn ordinary_prose_is_borrowed_unchanged() {
        let s = "The quick brown fox jumps over commit a1b2c3d and issue 12345.";
        let out = scrub(s);
        assert!(matches!(out, Cow::Borrowed(_)));
        assert_eq!(out, s);
    }
}
