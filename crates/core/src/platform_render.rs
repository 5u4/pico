pub fn defang_mentions(text: &str) -> String {
    text.replace("<@", "<@\u{200b}")
        .replace("@everyone", "@\u{200b}everyone")
        .replace("@here", "@\u{200b}here")
}

pub fn tables_to_lists(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut fence: Option<char> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(marker) = fence_marker(line) {
            match fence {
                Some(open) if open == marker => fence = None,
                Some(_) => {}
                None => fence = Some(marker),
            }
            out.push(line.to_string());
            i += 1;
            continue;
        }
        if fence.is_none()
            && let Some(headers) = lines.get(i + 1).and_then(|next| table_header(line, next))
        {
            let mut j = i + 2;
            let mut rows: Vec<Vec<String>> = Vec::new();
            while j < lines.len() && fence_marker(lines[j]).is_none() && is_table_row(lines[j]) {
                rows.push(split_cells(lines[j]));
                j += 1;
            }
            if !rows.is_empty() {
                render_table_as_list(&headers, &rows, &mut out);
                i = j;
                continue;
            }
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}

fn fence_marker(line: &str) -> Option<char> {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    if rest.starts_with("```") {
        Some('`')
    } else if rest.starts_with("~~~") {
        Some('~')
    } else {
        None
    }
}

fn table_header(header: &str, delim: &str) -> Option<Vec<String>> {
    if !is_table_row(header) {
        return None;
    }
    let cells = split_cells(header);
    let delim_cells = split_cells(delim);
    if cells.is_empty() || cells.len() != delim_cells.len() {
        return None;
    }
    delim_cells.iter().all(|c| is_delimiter_cell(c)).then_some(cells)
}

fn is_table_row(line: &str) -> bool {
    line.contains('|')
}

fn is_delimiter_cell(cell: &str) -> bool {
    let body = cell.strip_prefix(':').unwrap_or(cell);
    let body = body.strip_suffix(':').unwrap_or(body);
    !body.is_empty() && body.chars().all(|c| c == '-')
}

fn split_cells(line: &str) -> Vec<String> {
    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = line.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if matches!(chars.peek().copied(), Some('|' | '\\')) => {
                cur.push(chars.next().unwrap());
            }
            '|' => {
                cells.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    cells.push(cur.trim().to_string());
    if cells.first().is_some_and(String::is_empty) {
        cells.remove(0);
    }
    if cells.last().is_some_and(String::is_empty) {
        cells.pop();
    }
    cells
}

fn render_table_as_list(headers: &[String], rows: &[Vec<String>], out: &mut Vec<String>) {
    for row in rows {
        let (indent, start) = match row.first() {
            Some(title) if !title.is_empty() => {
                out.push(format!("- **{title}**"));
                ("  ", 1)
            }
            _ => ("", 0),
        };
        for (j, value) in row.iter().enumerate().skip(start) {
            if value.is_empty() {
                continue;
            }
            match headers.get(j) {
                Some(h) if !h.is_empty() => out.push(format!("{indent}- {h}: {value}")),
                _ => out.push(format!("{indent}- {value}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn table_becomes_titled_nested_bullets() {
        let input =
            "| Name | Role | Status |\n| --- | --- | --- |\n| Alice | Admin | Active |\n| Bob | User | Disabled |";
        let expected =
            "- **Alice**\n  - Role: Admin\n  - Status: Active\n- **Bob**\n  - Role: User\n  - Status: Disabled";
        assert_eq!(tables_to_lists(input), expected);
    }

    #[test]
    fn table_without_outer_pipes_and_aligned_delimiter() {
        let input = "Name | Role\n:--- | ---:\nAlice | Admin";
        assert_eq!(tables_to_lists(input), "- **Alice**\n  - Role: Admin");
    }

    #[test]
    fn surrounding_prose_is_preserved() {
        let input = "Intro line.\n\n| K | V |\n| --- | --- |\n| x | 1 |\n\nOutro line.";
        let expected = "Intro line.\n\n- **x**\n  - V: 1\n\nOutro line.";
        assert_eq!(tables_to_lists(input), expected);
    }

    #[test]
    fn table_inside_fence_is_left_verbatim() {
        let backtick = "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```";
        assert_eq!(tables_to_lists(backtick), backtick);
        let tilde = "~~~\n| a | b |\n| - | - |\n```\n| 1 | 2 |\n~~~";
        assert_eq!(tables_to_lists(tilde), tilde);
    }

    #[test]
    fn non_table_constructs_stay_untouched() {
        let heading = "Heading text\n---\nBody paragraph.";
        assert_eq!(tables_to_lists(heading), heading);
        let mismatch = "a | b | c\n--- | ---";
        assert_eq!(tables_to_lists(mismatch), mismatch);
        let header_only = "| A | B |\n| --- | --- |";
        assert_eq!(tables_to_lists(header_only), header_only);
    }

    #[test]
    fn escaped_pipe_and_empty_cells_handled() {
        let escaped = "| Expr | Meaning |\n| --- | --- |\n| `a \\| b` | or |";
        assert_eq!(tables_to_lists(escaped), "- **`a | b`**\n  - Meaning: or");
        let empty = "| Name | Role | Status |\n| --- | --- | --- |\n| Alice |  | Active |";
        assert_eq!(tables_to_lists(empty), "- **Alice**\n  - Status: Active");
    }

    #[test]
    fn empty_title_cell_flattens_instead_of_bare_marker() {
        let input = "| Name | Role |\n| --- | --- |\n|  | Admin |";
        assert_eq!(tables_to_lists(input), "- Role: Admin");
    }
}
