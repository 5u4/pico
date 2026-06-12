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

        // A line longer than the budget (minified JSON, a long URL) is hard-
        // wrapped first, else it yields an oversized chunk Discord drops.
        if fence {
            emit_line(line, next_in_fence, in_fence, &open_info, budget, &mut content, &mut chunks);
        } else {
            for piece in hard_wrap(line, budget, in_fence, &open_info) {
                emit_line(&piece, next_in_fence, in_fence, &open_info, budget, &mut content, &mut chunks);
            }
        }

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

fn emit_line(
    line: &str,
    next_in_fence: bool,
    in_fence: bool,
    open_info: &str,
    budget: usize,
    content: &mut Vec<String>,
    chunks: &mut Vec<String>,
) {
    if !content.is_empty() && projected_len(content, line, next_in_fence) > budget {
        if in_fence {
            content.push("```".to_string());
        }
        chunks.push(content.join("\n"));
        content.clear();
        if in_fence {
            content.push(reopen_fence(open_info));
        }
    }
    content.push(line.to_string());
}

/// Break an over-budget line into budget-sized char pieces; inside a fence the
/// budget drops by the reopen/close marker length so each piece survives them.
fn hard_wrap(line: &str, budget: usize, in_fence: bool, open_info: &str) -> Vec<String> {
    let max = if in_fence {
        // reopen "```<info>" + the two join newlines + the closing "```".
        budget.saturating_sub(open_info.chars().count() + 8)
    } else {
        budget
    }
    .max(1);

    if line.chars().count() <= max {
        return vec![line.to_string()];
    }

    let mut pieces = Vec::new();
    let mut piece = String::new();
    let mut n = 0;
    for ch in line.chars() {
        if n == max {
            pieces.push(std::mem::take(&mut piece));
            n = 0;
        }
        piece.push(ch);
        n += 1;
    }
    if !piece.is_empty() {
        pieces.push(piece);
    }
    pieces
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
    fn hard_splits_an_overlong_line_outside_a_fence() {
        let text = "x".repeat(50);
        let budget = 20;
        let chunks = split_to_budget(&text, budget);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= budget);
        }
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn hard_splits_an_overlong_line_inside_a_fence() {
        let text = format!("```\n{}\n```", "y".repeat(60));
        let budget = 25;
        let chunks = split_to_budget(&text, budget);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= budget);
            assert!(chunk.starts_with("```"));
            assert!(chunk.ends_with("```"));
        }
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
