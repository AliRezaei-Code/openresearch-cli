//! Independent alphaXiv retrieval primitives for the main agent.

use crate::client::{
    discover_papers_by_embedding, discover_papers_by_keyword, PaperDiscoveryOptions,
};
use crate::error::{anyhow, Result};

pub async fn run(args: crate::DiscoverArgs) -> Result<()> {
    ensure_alphaxiv_enabled(&crate::config::disabled_lit_sources())?;

    let results = match args.command {
        crate::DiscoverCommand::Keyword(args) => {
            discover_papers_by_keyword(&args.query, options(&args)).await?
        }
        crate::DiscoverCommand::Embedding(args) => {
            discover_papers_by_embedding(&args.query, options(&args)).await?
        }
    };

    println!("{}", serde_json::to_string_pretty(&results)?);
    Ok(())
}

fn options(args: &crate::DiscoverySearchArgs) -> PaperDiscoveryOptions<'_> {
    PaperDiscoveryOptions {
        published_after: args.published_after.as_deref(),
        published_before: args.published_before.as_deref(),
        prioritize: args.prioritize.as_str(),
    }
}

fn ensure_alphaxiv_enabled(disabled: &[String]) -> Result<()> {
    if disabled.iter().any(|source| source == "alphaxiv") {
        return Err(anyhow!(
            "alphaXiv is disabled by your OpenResearch literature-source configuration. Re-enable it to discover alphaXiv papers."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ensure_alphaxiv_enabled;

    #[test]
    fn respects_disabled_alphaxiv_source() {
        let error = ensure_alphaxiv_enabled(&["alphaxiv".to_string()])
            .expect_err("disabled alphaXiv should reject retrieval");
        assert!(error.to_string().contains("alphaXiv is disabled"));
        ensure_alphaxiv_enabled(&[]).expect("enabled alphaXiv should permit retrieval");
    }
}
