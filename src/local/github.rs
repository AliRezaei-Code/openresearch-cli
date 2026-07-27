//! Minimal GitHub REST calls for local mode — create a repo on the signed-in
//! user's account or in an organization, check push access, fork-by-copy.
//! Token from `GITHUB_TOKEN` or `gh auth token`, same resolution the clone path
//! uses.

use std::time::Duration;

use serde_json::{json, Value};

use super::git::resolve_github_token;
use crate::error::{anyhow, Result};

const UA: &str = concat!("orx/", env!("CARGO_PKG_VERSION"));

/// Create a blank private repo with an auto-init commit so the clone/branch
/// flow works immediately. An organization target is optional; without one,
/// GitHub creates the repo under the token's user.
pub async fn create_repo(
    repo: &str,
    organization: Option<&str>,
) -> Result<(String, String, String)> {
    create_repo_api(repo, true, organization).await
}

/// Whether the token can push to `owner/repo`. `None` means "could not
/// determine" (no token, network error, auth trouble) — callers should treat
/// that as access rather than surprise-forking on a transient failure.
/// GET an api.github.com URL with the resolved token. `None` when there's no
/// token or the request fails — callers decide what that means.
async fn authed_get(url: &str) -> Option<reqwest::Response> {
    let token = resolve_github_token()?;
    reqwest::Client::builder()
        // Without a timeout a black-holed connection hangs the caller — and
        // the New project form blocks on this check.
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

/// What the New project form needs about a repo, from one API call.
pub struct RepoMeta {
    pub can_push: bool,
    /// The repo's own default branch — the honest baseline when the user
    /// doesn't pick one (`create_project` would otherwise assume "main").
    pub default_branch: Option<String>,
}

/// The signed-in GitHub login, so the UI can name the account a new repo lands
/// on instead of guessing "you". `None` when there's no usable token.
pub async fn viewer_login() -> Option<String> {
    let res = authed_get("https://api.github.com/user").await?;
    if !res.status().is_success() {
        return None;
    }
    let body: Value = res.json().await.ok()?;
    body.get("login")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Repo permissions + default branch. `None` means we couldn't tell (no token,
/// API hiccup); callers treat that as "assume access" so a check outage never
/// forces a surprise fork.
pub async fn repo_meta(owner: &str, repo: &str) -> Option<RepoMeta> {
    // Encoded: owner/repo reach here straight from a text field, and a stray
    // `/` or `..` would otherwise re-point the request at another endpoint.
    let res = authed_get(&format!(
        "https://api.github.com/repos/{}/{}",
        urlencoding::encode(owner),
        urlencoding::encode(repo)
    ))
    .await?;
    match res.status() {
        // Not visible with this token: definitely can't push.
        reqwest::StatusCode::NOT_FOUND => Some(RepoMeta {
            can_push: false,
            default_branch: None,
        }),
        s if s.is_success() => {
            let body: Value = res.json().await.ok()?;
            Some(RepoMeta {
                can_push: body
                    .pointer("/permissions/push")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_branch: body
                    .get("default_branch")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            })
        }
        _ => None,
    }
}

/// Fork-by-copy: snapshot `src_owner/src_repo` (at `src_branch`, or its
/// default) into a fresh private repo `<slug>-<hash>` on the token's user —
/// the same import convention the platform uses — so the project always ends
/// up on a repo the user can push to. Returns (owner, repo, default_branch).
pub async fn fork_copy_repo(
    src_owner: &str,
    src_repo: &str,
    src_branch: Option<String>,
    destination_organization: Option<&str>,
) -> Result<(String, String, String)> {
    let hash = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let name = format!("{}-{hash}", crate::local::slugify(src_repo));
    let (owner, name, _) = create_repo_api(&name, false, destination_organization).await?;
    let (src_owner, src_repo) = (src_owner.to_string(), src_repo.to_string());
    let (dst_owner, dst_repo) = (owner.clone(), name.clone());
    tokio::task::spawn_blocking(move || {
        super::git::seed_copy(
            &src_owner,
            &src_repo,
            src_branch.as_deref(),
            &dst_owner,
            &dst_repo,
        )
    })
    .await
    .map_err(|e| anyhow!("seed task failed: {e}"))??;
    Ok((owner, name, "main".to_string()))
}

fn create_repo_endpoint(organization: Option<&str>) -> Result<String> {
    let Some(organization) = organization
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok("https://api.github.com/user/repos".to_string());
    };
    let valid = organization.len() <= 39
        && !organization.starts_with('-')
        && !organization.ends_with('-')
        && !organization.contains("--")
        && organization
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
    if !valid {
        return Err(anyhow!("Invalid GitHub organization login: {organization}"));
    }
    Ok(format!("https://api.github.com/orgs/{organization}/repos"))
}

async fn create_repo_api(
    repo: &str,
    auto_init: bool,
    organization: Option<&str>,
) -> Result<(String, String, String)> {
    let token = resolve_github_token().ok_or_else(|| {
        anyhow!(
            "Creating a GitHub repo needs credentials — run `gh auth login` or set GITHUB_TOKEN."
        )
    })?;
    let res = reqwest::Client::new()
        .post(create_repo_endpoint(organization)?)
        .bearer_auth(&token)
        .header("user-agent", UA)
        .header("accept", "application/vnd.github+json")
        .json(&json!({ "name": repo, "private": true, "auto_init": auto_init }))
        .send()
        .await
        .map_err(|e| anyhow!("GitHub API unreachable: {e}"))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        // Typically "name already exists on this account".
        let detail = body
            .pointer("/errors/0/message")
            .and_then(Value::as_str)
            .unwrap_or("invalid repository name");
        return Err(anyhow!("Could not create '{repo}': {detail}."));
    }
    if !status.is_success() {
        let msg = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(anyhow!("GitHub repo create failed ({status}): {msg}"));
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
    use super::create_repo_endpoint;

    #[test]
    fn repository_endpoint_targets_user_or_organization() {
        assert_eq!(
            create_repo_endpoint(None).unwrap(),
            "https://api.github.com/user/repos"
        );
        assert_eq!(
            create_repo_endpoint(Some("alphaXiv")).unwrap(),
            "https://api.github.com/orgs/alphaXiv/repos"
        );
        assert!(create_repo_endpoint(Some("not/an/org")).is_err());
    }
}
