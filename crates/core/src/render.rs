pub const DISCORD_BUDGET: usize = 1800;

pub fn split_to_budget(text: &str, budget: usize) -> Vec<String> {
    if text.trim().is_empty() {
        return Vec::new();
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut content: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut open_info = String::new();

    for line in text.lines() {
        let fence = is_fence_line(line);
        let next_in_fence = if fence { !in_fence } else { in_fence };
        let next_open_info = if fence && !in_fence {
            fence_info(line)
        } else {
            open_info.clone()
        };

        if !content.is_empty() && projected_len(&content, line, next_in_fence) > budget {
            if in_fence {
                content.push("```".to_string());
            }
            chunks.push(content.join("\n"));
            content = Vec::new();
            if in_fence {
                content.push(reopen_fence(&open_info));
            }
        }

        content.push(line.to_string());
        in_fence = next_in_fence;
        open_info = next_open_info;
    }

    if !content.is_empty() {
        chunks.push(content.join("\n"));
    }

    chunks
}

pub fn defang_mentions(text: &str) -> String {
    text.replace("<@", "<@\u{200b}")
        .replace("@everyone", "@\u{200b}everyone")
        .replace("@here", "@\u{200b}here")
}

fn projected_len(content: &[String], line: &str, next_in_fence: bool) -> usize {
    let mut n: usize = content.iter().map(|l| l.chars().count()).sum();
    if !content.is_empty() {
        n += content.len() - 1;
        n += 1;
    }
    n += line.chars().count();
    if next_in_fence {
        n += 1 + 3;
    }
    n
}

fn is_fence_line(line: &str) -> bool {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    indent <= 3 && line[indent..].starts_with("```")
}

fn fence_info(line: &str) -> String {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    line[indent + 3..].trim().to_string()
}

fn reopen_fence(info: &str) -> String {
    format!("```{info}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_returns_empty_vec() {
        assert!(split_to_budget("", DISCORD_BUDGET).is_empty());
        assert!(split_to_budget("   \n  \t ", DISCORD_BUDGET).is_empty());
    }

    #[test]
    fn never_exceeds_budget_and_never_splits_lines() {
        let text = "aaaa\nbbbb\ncccc\ndddd\neeee\nffff";
        let budget = 10;
        let chunks = split_to_budget(text, budget);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= budget);
        }
        assert_eq!(chunks.join("\n"), text);
    }

    #[test]
    fn straddling_rust_fence_closes_and_reopens() {
        let text = "```rust\nlet a = 1;\nlet b = 2;\nlet c = 3;\n```";
        let budget = 30;
        let chunks = split_to_budget(text, budget);
        assert!(chunks.len() >= 2);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= budget);
        }
        assert!(chunks[0].ends_with("```"));
        assert!(chunks[1].starts_with("```rust"));
    }

    #[test]
    fn defang_neutralizes_pings_and_spares_plain_text() {
        assert_eq!(defang_mentions("@everyone"), "@\u{200b}everyone");
        assert_eq!(defang_mentions("@here"), "@\u{200b}here");
        assert_eq!(defang_mentions("<@123>"), "<@\u{200b}123>");
        assert_eq!(defang_mentions("<@!123>"), "<@\u{200b}!123>");
        assert_eq!(defang_mentions("<@&456>"), "<@\u{200b}&456>");
        assert_eq!(defang_mentions("email@example.com"), "email@example.com");
        assert_eq!(defang_mentions("plain text"), "plain text");
    }
}
