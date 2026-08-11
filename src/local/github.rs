//! Minimal GitHub REST calls for optional project publication.

use std::time::Duration;

use serde_json::{json, Value};

use super::git::resolve_github_token;
use crate::error::{anyhow, Error, Result};

const UA: &str = concat!("orx/", env!("CARGO_PKG_VERSION"));
pub const SHALLOW_CLONE_THRESHOLD_KB: u64 = 250 * 1024;

pub fn should_shallow_clone(size_kb: Option<u64>) -> bool {
    size_kb.is_some_and(|size| size >= SHALLOW_CLONE_THRESHOLD_KB)
}

#[derive(Debug)]
struct RepositoryNameExists;

impl std::fmt::Display for RepositoryNameExists {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("repository name already exists")
    }
}

impl std::error::Error for RepositoryNameExists {}

pub async fn create_project_repo(repo: &str) -> Result<(String, String, String)> {
    for suffix in 1..=100 {
        let candidate = if suffix == 1 {
            repo.to_string()
        } else {
            format!("{repo}-{suffix}")
        };
        match create_repo_api(&candidate, false).await {
            Err(error) if error.downcast_ref::<RepositoryNameExists>().is_some() => continue,
            result => return result,
        }
    }
    Err(anyhow!(
        "Could not find an available GitHub repository name for '{repo}'."
    ))
}

pub async fn available_project_repo_name(repo: &str) -> String {
    let Some(owner) = viewer_login().await else {
        return repo.to_string();
    };
    for suffix in 1..=100 {
        let candidate = if suffix == 1 {
            repo.to_string()
        } else {
            format!("{repo}-{suffix}")
        };
        if repo_meta(&owner, &candidate).await.is_none() {
            return candidate;
        }
    }
    repo.to_string()
}

async fn authed_get(url: &str) -> Option<reqwest::Response> {
    let token = resolve_github_token()?;
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?
        .get(url)
        .bearer_auth(&token)
        .header("user-agent", UA)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .ok()
}

pub async fn public_repo_size_kb(url: &str) -> Option<u64> {
    let (owner, repo) = super::git::github_repository(url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let mut request = client
        .get(format!(
            "https://api.github.com/repos/{}/{}",
            urlencoding::encode(&owner),
            urlencoding::encode(&repo)
        ))
        .header("user-agent", UA)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28");
    if let Some(token) = resolve_github_token() {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    body.get("size").and_then(Value::as_u64)
}

pub struct RepoMeta {
    pub can_push: bool,
    pub archived: bool,
}

pub async fn viewer_login() -> Option<String> {
    let response = authed_get("https://api.github.com/user").await?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    body.get("login")
        .and_then(Value::as_str)
        .filter(|login| !login.is_empty())
        .map(str::to_string)
}

pub async fn repo_meta(owner: &str, repo: &str) -> Option<RepoMeta> {
    let response = authed_get(&format!(
        "https://api.github.com/repos/{}/{}",
        urlencoding::encode(owner),
        urlencoding::encode(repo)
    ))
    .await?;
    match response.status() {
        reqwest::StatusCode::NOT_FOUND => None,
        status if status.is_success() => {
            let body: Value = response.json().await.ok()?;
            Some(RepoMeta {
                can_push: body
                    .pointer("/permissions/push")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                archived: body
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        }
        _ => None,
    }
}

async fn create_repo_api(repo: &str, auto_init: bool) -> Result<(String, String, String)> {
    let token = resolve_github_token().ok_or_else(|| {
        anyhow!("Creating a GitHub repo needs credentials — run `gh auth login` or connect a GitHub token.")
    })?;
    let response = reqwest::Client::new()
        .post("https://api.github.com/user/repos")
        .bearer_auth(&token)
        .header("user-agent", UA)
        .header("accept", "application/vnd.github+json")
        .json(&json!({ "name": repo, "private": true, "auto_init": auto_init }))
        .send()
        .await
        .map_err(|error| anyhow!("GitHub API unreachable: {error}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        let detail = body
            .pointer("/errors/0/message")
            .and_then(Value::as_str)
            .unwrap_or("invalid repository name");
        let code = body.pointer("/errors/0/code").and_then(Value::as_str);
        if code == Some("already_exists") || detail.to_ascii_lowercase().contains("already exists")
        {
            return Err(Error::new(RepositoryNameExists));
        }
        return Err(anyhow!("Could not create '{repo}': {detail}."));
    }
    if !status.is_success() {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(anyhow!("GitHub repo create failed ({status}): {message}"));
    }
    let owner = body
        .pointer("/owner/login")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("GitHub response missing owner login"))?
        .to_string();
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(repo)
        .to_string();
    let default_branch = body
        .get("default_branch")
        .and_then(Value::as_str)
        .unwrap_or("main")
        .to_string();
    Ok((owner, name, default_branch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shallow_clone_is_reserved_for_large_repositories() {
        assert!(!should_shallow_clone(None));
        assert!(!should_shallow_clone(Some(SHALLOW_CLONE_THRESHOLD_KB - 1)));
        assert!(should_shallow_clone(Some(SHALLOW_CLONE_THRESHOLD_KB)));
    }
}
