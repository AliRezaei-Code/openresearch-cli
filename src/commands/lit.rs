//! The `lit` command — agent-driven literature retrieval over alphaXiv, OpenAlex,
//! or bioRxiv (`--source`; omitted = the first source enabled in Settings).
//!
//! alphaXiv runs keyword and semantic retrieval in parallel and leaves ranking,
//! follow-up queries, and stopping to the calling agent. Public endpoints require
//! no token. bioRxiv has no search API, so that source searches OpenAlex filtered
//! to bioRxiv's corpus.

use std::collections::HashSet;

use crate::client::{
    search_openalex, search_papers, search_papers_semantic, LitHit, PaperHit, PaperSearchOptions,
    BIORXIV_SOURCE_ID,
};
use crate::error::{anyhow, Result};
use crate::LitSource;

pub async fn run(args: crate::LitArgs) -> Result<()> {
    let source = resolve_lit_source(args.source, &crate::config::disabled_lit_sources())?;
    validate_alphaxiv_options_source(
        args.source,
        source,
        args.published_after.is_some()
            || args.published_before.is_some()
            || !args.keywords.is_empty()
            || args.prioritize.is_some(),
    )?;
    // When no --source was given and the default (alphaXiv) is disabled, say which
    // source we fell back to, so the caller doesn't assume alphaXiv results.
    if args.source.is_none() && source != LitSource::Alphaxiv {
        eprintln!(
            "alphaXiv is disabled in Settings — searching {} instead.",
            source.display_name()
        );
    }
    let limit = args
        .limit
        .unwrap_or(if source == LitSource::Alphaxiv { 15 } else { 5 });

    match source {
        LitSource::Alphaxiv => run_alphaxiv_round(&args, limit).await,
        LitSource::Openalex => {
            print_flat_results(&args, search_openalex(&args.query, limit, None).await?)
        }
        LitSource::Biorxiv => print_flat_results(
            &args,
            search_openalex(&args.query, limit, Some(BIORXIV_SOURCE_ID)).await?,
        ),
    }
}

struct RetrievalSet {
    label: &'static str,
    query: String,
    hits: Vec<LitHit>,
}

async fn run_alphaxiv_round(args: &crate::LitArgs, limit: u32) -> Result<()> {
    let keyword_query = if args.keywords.is_empty() {
        args.query.clone()
    } else {
        args.keywords.join(" ")
    };
    let acronym_query = acronym_only_query(&args.keywords);
    let priority = args.prioritize.map(|value| value.as_str());
    let options = PaperSearchOptions {
        limit,
        published_after: args.published_after.as_deref(),
        published_before: args.published_before.as_deref(),
        prioritize: priority,
    };

    let keyword_search = search_papers(&keyword_query, options);
    let semantic_search = search_papers_semantic(&args.query, options);
    let acronym_search = async {
        match acronym_query.as_deref() {
            Some(query) => search_papers(query, options).await,
            None => Ok(Vec::new()),
        }
    };
    let (keyword_result, semantic_result, acronym_result) =
        tokio::join!(keyword_search, semantic_search, acronym_search);

    let mut sets = Vec::new();
    let mut failures = Vec::new();
    collect_retrieval_result(
        &mut sets,
        &mut failures,
        "Keyword results",
        keyword_query,
        keyword_result,
    );
    collect_retrieval_result(
        &mut sets,
        &mut failures,
        "Semantic results",
        args.query.clone(),
        semantic_result,
    );
    if let Some(query) = acronym_query {
        collect_retrieval_result(
            &mut sets,
            &mut failures,
            "Acronym-only keyword results",
            query,
            acronym_result,
        );
    }

    if sets.is_empty() {
        return Err(anyhow!(
            "All alphaXiv retrieval strategies failed: {}",
            failures.join("; ")
        ));
    }
    for failure in failures {
        eprintln!("Warning: {failure}");
    }

    if args.json {
        println!("{}", serde_json::to_string_pretty(&merge_hits(&sets))?);
        return Ok(());
    }
    if sets.iter().all(|set| set.hits.is_empty()) {
        eprintln!("No papers found for {:?}.", args.query);
        return Ok(());
    }
    let mut printed = HashSet::new();
    for set in &sets {
        print_retrieval_set(set, &mut printed);
    }
    eprintln!("Rank the candidates by the user's question. Fetch details with: orx paper <id>");
    Ok(())
}

fn collect_retrieval_result(
    sets: &mut Vec<RetrievalSet>,
    failures: &mut Vec<String>,
    label: &'static str,
    query: String,
    result: Result<Vec<PaperHit>>,
) {
    match result {
        Ok(hits) => sets.push(RetrievalSet {
            label,
            query,
            hits: hits.into_iter().map(LitHit::from).collect(),
        }),
        Err(error) => failures.push(format!("{label} unavailable: {error}")),
    }
}

fn print_retrieval_set(set: &RetrievalSet, printed: &mut HashSet<String>) {
    println!("## {}\nQuery: {}\n", set.label, set.query);
    let mut index = 0;
    for hit in &set.hits {
        if !printed.insert(hit.id.clone()) {
            continue;
        }
        index += 1;
        let date = publication_date(hit);
        let abstract_ = collapse_ws(&hit.abstract_);
        println!(
            "{}. [ID={}] **{}**. Published {} · {}: {}",
            index,
            hit.id,
            hit.title,
            date,
            metric(hit),
            truncate_chars(&abstract_, 200)
        );
        let snippets = hit
            .snippets
            .iter()
            .take(2)
            .map(|snippet| {
                format!(
                    "[p.{}] {}",
                    snippet.page_number,
                    collapse_ws(&snippet.snippet)
                )
            })
            .collect::<Vec<_>>()
            .join(" | ");
        if !snippets.is_empty() {
            println!("   Matches: {snippets}");
        }
    }
    if index == 0 {
        println!("No additional papers found.");
    }
    println!();
}

fn merge_hits(sets: &[RetrievalSet]) -> Vec<LitHit> {
    let mut seen = HashSet::new();
    sets.iter()
        .flat_map(|set| set.hits.iter())
        .filter(|hit| seen.insert(hit.id.clone()))
        .cloned()
        .collect()
}

fn print_flat_results(args: &crate::LitArgs, hits: Vec<LitHit>) -> Result<()> {
    if args.json {
        println!("{}", serde_json::to_string_pretty(&hits)?);
        return Ok(());
    }
    if hits.is_empty() {
        eprintln!("No papers found for {:?}.", args.query);
        return Ok(());
    }
    for hit in &hits {
        println!("{}  {}", hit.id, hit.title);
        println!("            {} · {}", publication_date(hit), metric(hit));
        let abstract_ = collapse_ws(&hit.abstract_);
        if !abstract_.is_empty() {
            println!("            {}", truncate_chars(&abstract_, 300));
        }
        println!();
    }
    eprintln!("Fetch a report with: orx paper <id>");
    Ok(())
}

fn publication_date(hit: &LitHit) -> &str {
    hit.publication_date
        .as_deref()
        .and_then(|date| date.split('T').next())
        .unwrap_or("—")
}

fn acronym_only_query(keywords: &[String]) -> Option<String> {
    let acronyms = keywords
        .iter()
        .map(|keyword| keyword.trim())
        .filter(|keyword| is_acronym(keyword))
        .collect::<Vec<_>>();
    if acronyms.is_empty() || acronyms.len() == keywords.len() {
        return None;
    }
    Some(acronyms.join(" "))
}

// Mirrors alphaXiv's discover_papers recovery heuristic for collision-prone names.
fn is_acronym(term: &str) -> bool {
    let characters = term.chars().collect::<Vec<_>>();
    (2..=10).contains(&characters.len())
        && characters
            .first()
            .is_some_and(|character| character.is_alphabetic())
        && characters
            .iter()
            .all(|character| character.is_alphanumeric() || *character == '-')
        && characters
            .iter()
            .filter(|character| character.is_uppercase())
            .count()
            >= 2
}

fn validate_alphaxiv_options_source(
    explicit: Option<LitSource>,
    resolved: LitSource,
    has_alphaxiv_options: bool,
) -> Result<()> {
    if !has_alphaxiv_options || resolved == LitSource::Alphaxiv {
        return Ok(());
    }
    if explicit.is_none() {
        return Err(anyhow!(
            "--keyword, --prioritize, --published-after, and --published-before require alphaXiv, but alphaXiv is disabled in Settings. Re-enable it or remove those options to search {}.",
            resolved.display_name()
        ));
    }
    Err(anyhow!(
        "--keyword, --prioritize, --published-after, and --published-before are supported only for alphaXiv searches"
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
    use super::{
        acronym_only_query, collect_retrieval_result, merge_hits, resolve_lit_source,
        validate_alphaxiv_options_source, RetrievalSet,
    };
    use crate::client::{LitHit, PaperHit};
    use crate::error::anyhow;
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
        let error = validate_alphaxiv_options_source(None, LitSource::Openalex, true)
            .expect_err("fallback with date bounds should fail");

        assert!(error
            .to_string()
            .contains("alphaXiv is disabled in Settings"));
        assert!(validate_alphaxiv_options_source(
            Some(LitSource::Alphaxiv),
            LitSource::Alphaxiv,
            true
        )
        .is_ok());
    }

    #[test]
    fn isolates_acronyms_when_other_keywords_are_present() {
        assert_eq!(
            acronym_only_query(&["SDPO".into(), "preference optimization".into()]),
            Some("SDPO".into())
        );
        assert_eq!(acronym_only_query(&["GRPO".into(), "DAPO".into()]), None);
        assert_eq!(acronym_only_query(&["transformers".into()]), None);
    }

    #[test]
    fn keeps_successful_retrieval_when_another_strategy_fails() {
        let mut sets = Vec::new();
        let mut failures = Vec::new();
        collect_retrieval_result(
            &mut sets,
            &mut failures,
            "Keyword results",
            "attention".into(),
            Ok(vec![paper_hit("2401.00001")]),
        );
        collect_retrieval_result(
            &mut sets,
            &mut failures,
            "Semantic results",
            "attention mechanisms".into(),
            Err(anyhow!("semantic search unavailable")),
        );

        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].hits[0].id, "2401.00001");
        assert_eq!(failures.len(), 1);
    }

    #[test]
    fn merged_json_hits_keep_the_first_strategy_order() {
        let sets = vec![
            RetrievalSet {
                label: "Keyword results",
                query: "attention".into(),
                hits: vec![lit_hit("a"), lit_hit("b")],
            },
            RetrievalSet {
                label: "Semantic results",
                query: "attention mechanisms".into(),
                hits: vec![lit_hit("b"), lit_hit("c")],
            },
        ];

        assert_eq!(
            merge_hits(&sets)
                .into_iter()
                .map(|hit| hit.id)
                .collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
    }

    fn paper_hit(id: &str) -> PaperHit {
        PaperHit {
            paper_id: id.into(),
            title: "Paper".into(),
            abstract_: String::new(),
            publication_date: None,
            votes: 0,
            snippets: Vec::new(),
        }
    }

    fn lit_hit(id: &str) -> LitHit {
        LitHit::from(paper_hit(id))
    }
}
