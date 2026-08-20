//! The `lit` command — full-text literature search over alphaXiv, OpenAlex, or
//! bioRxiv (`--source`; omitted = the first source enabled in Settings).
//!
//! Public endpoints, no token required. Prints a compact, agent-readable list of
//! hits (id, title, date, metric, truncated abstract) by default, or raw JSON
//! with `--json`. Pull a hit next with `orx paper <id>`. bioRxiv has no search
//! API, so `--source biorxiv` searches OpenAlex filtered to bioRxiv's corpus.

use crate::client::{search_openalex, search_papers, LitHit, BIORXIV_SOURCE_ID};
use crate::error::{anyhow, Result};
use crate::LitSource;

pub async fn run(args: crate::LitArgs) -> Result<()> {
    let limit = args.limit.unwrap_or(5);
    let source = resolve_lit_source(args.source, &crate::config::disabled_lit_sources())?;
    validate_date_bounds_source(
        args.source,
        source,
        args.published_after.is_some() || args.published_before.is_some(),
    )?;
    // When no --source was given and the default (alphaXiv) is disabled, say which
    // source we fell back to, so the caller doesn't assume alphaXiv results.
    if args.source.is_none() && source != LitSource::Alphaxiv {
        eprintln!(
            "alphaXiv is disabled in Settings — searching {} instead.",
            source.display_name()
        );
    }
    let hits: Vec<LitHit> = match source {
        LitSource::Alphaxiv => search_papers(
            &args.query,
            limit,
            args.published_after.as_deref(),
            args.published_before.as_deref(),
        )
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

fn validate_date_bounds_source(
    explicit: Option<LitSource>,
    resolved: LitSource,
    has_date_bounds: bool,
) -> Result<()> {
    if !has_date_bounds || resolved == LitSource::Alphaxiv {
        return Ok(());
    }
    if explicit.is_none() {
        return Err(anyhow!(
            "Publication date filters require alphaXiv, but alphaXiv is disabled in Settings. Re-enable it or remove the filters to search {}.",
            resolved.display_name()
        ));
    }
    Err(anyhow!(
        "--published-after and --published-before are supported only for alphaXiv searches"
    ))
}

/// Pick the source to search, honoring the Settings disable-set. An explicit
/// `--source` that's disabled is an error; with no `--source`, fall back to the
/// first enabled source in preference order (all disabled → error).
fn resolve_lit_source(explicit: Option<LitSource>, disabled: &[String]) -> Result<LitSource> {
    let is_disabled = |s: LitSource| disabled.iter().any(|d| d == s.as_str());
    if let Some(s) = explicit {
        if is_disabled(s) {
            return Err(anyhow!(
                "{} is disabled by your OpenResearch literature-source configuration. Re-enable it or pick another --source.",
                s.display_name()
            ));
        }
        return Ok(s);
    }
    LitSource::ALL
        .into_iter()
        .find(|&s| !is_disabled(s))
        .ok_or_else(|| {
            anyhow!("All literature sources are disabled by your OpenResearch configuration.")
        })
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

#[cfg(test)]
mod tests {
    use super::{resolve_lit_source, validate_date_bounds_source};
    use crate::LitSource;

    fn disabled(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn resolves_source_honoring_disabled_set() {
        // Explicit source that's enabled passes through.
        assert_eq!(
            resolve_lit_source(Some(LitSource::Openalex), &[]).unwrap(),
            LitSource::Openalex
        );
        // Explicit disabled source errors.
        assert!(resolve_lit_source(Some(LitSource::Biorxiv), &disabled(&["biorxiv"])).is_err());
        // No --source → alphaxiv when enabled.
        assert_eq!(resolve_lit_source(None, &[]).unwrap(), LitSource::Alphaxiv);
        // No --source, alphaxiv disabled → next enabled (openalex).
        assert_eq!(
            resolve_lit_source(None, &disabled(&["alphaxiv"])).unwrap(),
            LitSource::Openalex
        );
        // No --source, only biorxiv enabled → biorxiv.
        assert_eq!(
            resolve_lit_source(None, &disabled(&["alphaxiv", "openalex"])).unwrap(),
            LitSource::Biorxiv
        );
        // Everything disabled → error.
        assert!(resolve_lit_source(None, &disabled(&["alphaxiv", "openalex", "biorxiv"])).is_err());
        // An unknown/stale name in the set matches no real source and is ignored.
        assert_eq!(
            resolve_lit_source(Some(LitSource::Alphaxiv), &disabled(&["ghost"])).unwrap(),
            LitSource::Alphaxiv
        );
    }

    #[test]
    fn date_bounds_explain_disabled_alphaxiv_fallback() {
        let error = validate_date_bounds_source(None, LitSource::Openalex, true)
            .expect_err("fallback with date bounds should fail");

        assert!(error
            .to_string()
            .contains("alphaXiv is disabled in Settings"));
        assert!(
            validate_date_bounds_source(Some(LitSource::Alphaxiv), LitSource::Alphaxiv, true)
                .is_ok()
        );
    }
}
