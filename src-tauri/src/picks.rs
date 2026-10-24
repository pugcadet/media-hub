//! "Picks of the day". Same date + same library = same picks, on every computer,
//! with no randomness and no stored state. A new day gives a new set.

/// Stable 64-bit hash (FNV-1a). Not for security, only for an even, repeatable shuffle.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Accepts only `YYYY-MM-DD`.
pub fn valid_date(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Picks `n` ids for the given day. `salt` keeps different lists (movies, shows)
/// from always moving in lockstep.
pub fn pick_ids(candidates: &[String], date: &str, salt: &str, n: usize) -> Vec<String> {
    let mut scored: Vec<(u64, &String)> = candidates
        .iter()
        .map(|id| (fnv1a(&format!("{date}|{salt}|{id}")), id))
        .collect();
    // Ties are broken by id so the order never depends on input order.
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    scored.into_iter().take(n).map(|(_, id)| id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("id{i:03}")).collect()
    }

    #[test]
    fn same_day_same_picks_even_if_input_order_changes() {
        let a = ids(50);
        let mut b = a.clone();
        b.reverse();
        assert_eq!(pick_ids(&a, "2026-10-24", "movie", 3), pick_ids(&b, "2026-10-24", "movie", 3));
    }

    #[test]
    fn different_days_differ() {
        let a = ids(200);
        let mut seen = std::collections::HashSet::new();
        for day in 1..=10 {
            seen.insert(pick_ids(&a, &format!("2026-10-{day:02}"), "movie", 2));
        }
        assert!(seen.len() >= 8, "picks barely change between days");
    }

    #[test]
    fn handles_small_and_empty_lists() {
        assert!(pick_ids(&[], "2026-10-24", "movie", 3).is_empty());
        assert_eq!(pick_ids(&ids(2), "2026-10-24", "movie", 5).len(), 2);
    }

    #[test]
    fn no_duplicates() {
        let p = pick_ids(&ids(30), "2026-10-24", "series", 10);
        let set: std::collections::HashSet<_> = p.iter().collect();
        assert_eq!(set.len(), p.len());
    }

    #[test]
    fn date_check() {
        assert!(valid_date("2026-10-24"));
        assert!(!valid_date("2026-1-24"));
        assert!(!valid_date("24-10-2026"));
        assert!(!valid_date("2026-10-2x"));
        assert!(!valid_date("'; DROP"));
    }
}
