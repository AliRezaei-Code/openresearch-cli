//! The `lit` command — full-text literature search over alphaXiv, OpenAlex, or
//! bioRxiv (`--source`, default alphaxiv).
//!
//! Public endpoints, no token required. Prints a compact, agent-readable list of
//! hits (id, title, date, metric, truncated abstract) by default, or raw JSON
//! with `--json`. Pull a hit next with `orx paper <id>`. bioRxiv has no search
//! API, so `--source biorxiv` searches OpenAlex filtered to bioRxiv's corpus.

use crate::client::{search_openalex, search_papers, LitHit, BIORXIV_SOURCE_ID};
use crate::error::Result;
use crate::LitSource;

pub async fn run(args: crate::LitArgs) -> Result<()> {
    let limit = args.limit.unwrap_or(5);
    let hits: Vec<LitHit> = match args.source {
        LitSource::Alphaxiv => search_papers(&args.query, limit)
            .await?
            .into_iter()
            .map(LitHit::from)
            .collect(),
        LitSource::Openalex => search_openalex(&args.query, limit, None).await?,
        LitSource::Biorxiv => search_openalex(&args.query, limit, Some(BIORXIV_SOURCE_ID)).await?,
    };

    if args.json {
        println!("{}", serde_json::to_string_pretty(&hits)?);
        return Ok(());
    }

    if hits.is_empty() {
        eprintln!("No papers found for {:?}.", args.query);
        return Ok(());
    }

    for h in &hits {
        let date = h
            .publication_date
            .as_deref()
            .and_then(|d| d.split('T').next())
            .unwrap_or("—");
        println!("{}  {}", h.id, h.title);
        println!("            {} · {}", date, metric(h));
        let abstract_ = collapse_ws(&h.abstract_);
        if !abstract_.is_empty() {
            println!("            {}", truncate_chars(&abstract_, 300));
        }
        println!();
    }
    eprintln!("Fetch a report with: orx paper <id>");
    Ok(())
}

/// The per-source relevance/impact metric shown under each hit.
fn metric(h: &LitHit) -> String {
    if let Some(v) = h.votes {
        format!("{} votes", v)
    } else if let Some(c) = h.citations {
        format!("{} citations", c)
    } else {
        "—".to_string()
    }
}

/// Collapse runs of whitespace (incl. newlines) into single spaces and trim.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Truncate to at most `max` chars, appending `…` when shortened.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}
