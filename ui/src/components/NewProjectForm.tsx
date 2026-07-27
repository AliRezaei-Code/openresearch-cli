import { useEffect, useRef, useState } from "react";
import {
  createProject,
  githubAccount,
  repoAccess,
  resolvePaper,
  searchPapers,
  type PaperHit,
  type Project,
  type ResolvedPaper,
} from "../api";

/** owner/repo out of anything a user pastes: a full GitHub URL (https or ssh),
 * with or without .git, or the bare `owner/repo` shorthand. */
function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input
    .trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const [owner, repo] = s.split("/");
  if (!owner || !repo || /[\s:@]/.test(owner) || /[\s:@]/.test(repo)) return null;
  return { owner, repo };
}

/** Mirror of the server's slugify — previews the repo name a blank project gets. */
function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "experiment"
  );
}

/** Mirror of the server's parse_paper_id: bare/versioned arXiv ids and
 * arxiv.org / alphaxiv.org URLs. Null when the input reads as a title query. */
function parsePaperId(input: string): string | null {
  const s = input.trim().split(/[?#]/)[0];
  const last = s.split("/").filter(Boolean).pop() ?? "";
  const id = last.replace(/\.(pdf|md)$/i, "");
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(id) ? id : null;
}

/** Fast-search titles carry scrape cruft: "[1706.03762] Title - arXiv". */
function cleanTitle(title: string): string {
  return title.replace(/^\[[^\]]*\]\s*/, "").replace(/\s*[-–|]\s*arXiv\s*$/i, "");
}

type Mode = "existing" | "new" | "paper";
type RepoMode = "use" | "fork";

export function NewProjectForm({
  onCreated,
  onCancel,
}: {
  onCreated: (project: Project) => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("paper");
  const [repoMode, setRepoMode] = useState<RepoMode>("use");
  const [repoInput, setRepoInput] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  // No branch picker: the server uses the repo's own default branch. It's
  // write-once, invisible after creation, and right for ~everyone — so it's a
  // setting, not a question worth asking during project creation.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "From a paper" mode.
  const [paperQuery, setPaperQuery] = useState("");
  const [hits, setHits] = useState<PaperHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [paper, setPaper] = useState<ResolvedPaper | null>(null);
  const [resolving, setResolving] = useState(false);
  const [paperNote, setPaperNote] = useState<string | null>(null);
  // Drops out-of-order search/resolve responses.
  const paperSeq = useRef(0);

  // Push access for the entered repo: null while unknown/checking. The server
  // force-forks when this is false, so the fork choice is only a real choice
  // when it's true — otherwise we state what will happen instead of asking.
  const [canPush, setCanPush] = useState<boolean | null>(null);
  const [checkingAccess, setCheckingAccess] = useState(false);
  // The signed-in GitHub login, so previews name the real account. Falls back
  // to "you" when there's no usable token.
  const [ghLogin, setGhLogin] = useState<string | null>(null);
  useEffect(() => {
    void githubAccount()
      .then((r) => setGhLogin(r.login))
      .catch(() => setGhLogin(null));
  }, []);
  const ghOwner = ghLogin ?? "you";
  const accessSeq = useRef(0);

  const parsed = parseRepo(repoInput);
  const valid = Boolean(
    name.trim() &&
      (mode === "new" ||
        (mode === "existing" && parsed !== null) ||
        (mode === "paper" && paper !== null && (repoInput.trim() === "" || parsed !== null))),
  );

  const onRepoChange = (value: string) => {
    setRepoInput(value);
    // Name follows the repo until the user edits it themselves.
    if (!nameTouched) setName(parseRepo(value)?.repo ?? "");
  };

  async function selectPaper(id: string) {
    const seq = ++paperSeq.current;
    setHits([]);
    setSearching(false);
    setResolving(true);
    setPaperNote(null);
    try {
      const p = await resolvePaper(id);
      if (seq !== paperSeq.current) return;
      setPaper(p);
      const repo = p.repoUrl ? parseRepo(p.repoUrl) : null;
      setRepoInput(repo ? `${repo.owner}/${repo.repo}` : "");
      // Paper repos are rarely writable — default to a private copy.
      setRepoMode("fork");
      if (!nameTouched) setName(repo?.repo ?? (p.title ?? "").trim().slice(0, 60));
    } catch (err) {
      if (seq !== paperSeq.current) return;
      setPaperNote(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === paperSeq.current) setResolving(false);
    }
  }

  function clearPaper() {
    paperSeq.current++;
    setPaper(null);
    setPaperQuery("");
    setHits([]);
    setPaperNote(null);
    setRepoInput("");
    if (!nameTouched) setName("");
  }

  // Ask GitHub whether we can push to the entered repo, so the fork choice only
  // appears when the user actually has one.
  const repoKey = parsed ? `${parsed.owner}/${parsed.repo}` : "";
  useEffect(() => {
    if (!repoKey) {
      setCanPush(null);
      setCheckingAccess(false);
      return;
    }
    const [owner, repo] = repoKey.split("/");
    let live = true;
    setCheckingAccess(true);
    const t = setTimeout(() => {
      // seq is claimed when the request actually starts, not on every
      // keystroke — otherwise a superseded effect bumps it and the in-flight
      // response fails its own guard, leaving "checking…" stuck forever.
      const seq = ++accessSeq.current;
      repoAccess(owner, repo)
        .then((r) => {
          if (!live || seq !== accessSeq.current) return;
          setCanPush(r.canPush);
          // No push access → the server copies regardless; keep the two in sync.
          if (!r.canPush) setRepoMode("fork");
        })
        .catch(() => {
          // Unreachable check: assume access, matching the server's fallback.
          if (live && seq === accessSeq.current) setCanPush(true);
        })
        .finally(() => {
          if (live && seq === accessSeq.current) setCheckingAccess(false);
        });
    }, 400);
    return () => {
      // A newer effect owns the spinner now; never leave it on for a repo key
      // nobody is waiting for.
      live = false;
      clearTimeout(t);
    };
  }, [repoKey]);

  // Debounced lookup: an id/URL resolves directly, anything else title-searches.
  useEffect(() => {
    if (mode !== "paper" || paper) return;
    const q = paperQuery.trim();
    const id = parsePaperId(q);
    if (!id && q.length < 3) {
      setHits([]);
      setSearching(false);
      return;
    }
    const seq = ++paperSeq.current;
    if (!id) setSearching(true);
    const t = setTimeout(() => {
      if (id) {
        void selectPaper(id);
        return;
      }
      searchPapers(q)
        .then((res) => {
          if (seq === paperSeq.current) setHits(res);
        })
        .catch((err) => {
          if (seq !== paperSeq.current) return;
          setHits([]);
          setPaperNote(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seq === paperSeq.current) setSearching(false);
        });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, paper, paperQuery]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    try {
      const project = await createProject(
        mode === "new"
          ? { name: name.trim(), createRepo: true }
          : mode === "paper" && !parsed
            ? { name: name.trim(), createRepo: true, paperId: paper!.paperId }
            : {
                name: name.trim(),
                githubOwner: parsed!.owner,
                githubRepo: parsed!.repo,
                forkRepo: repoMode === "fork",
                ...(mode === "paper" ? { paperId: paper!.paperId } : {}),
              },
      );
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const creatingRepo = mode === "new" || (mode === "paper" && !parsed);
  const repoLabel = parsed ? `${parsed.owner}/${parsed.repo}` : "the repo";
  // Everything below the repo input is about a *specific* repo, so none of it
  // renders until one is entered and we know whether the user can push to it.
  // Showing "Use this repo" for a repo they can't push to is a false choice.
  const repoFields = !parsed ? null : checkingAccess || canPush === null ? (
    <span className="repo-hint">Checking your access to {repoLabel}…</span>
  ) : (
    <>
      {canPush === false ? (
        <span className="repo-hint">
          You can&apos;t push to {repoLabel}, so orx snapshots its latest commit into a new private
          repo on github.com/{ghOwner}. Your experiments push there.
        </span>
      ) : (
        <>
          <div className="seg form-seg">
            <button
              type="button"
              className={repoMode === "use" ? "active" : ""}
              onClick={() => setRepoMode("use")}
            >
              Use this repo
            </button>
            <button
              type="button"
              className={repoMode === "fork" ? "active" : ""}
              onClick={() => setRepoMode("fork")}
            >
              Private copy
            </button>
          </div>
          {/* `ok` (green) like the resolved owner/repo above: this states the
              confirmed outcome, not a caveat. */}
          <span className="repo-hint mono ok">
            {repoMode === "fork"
              ? // Not a GitHub fork: seed_copy does a --depth=1 --single-branch
                // clone, then an orphan commit. One branch, no history, no fork
                // link — say so rather than letting "copy" imply otherwise.
                `Snapshots the latest commit of ${repoLabel} into a new private repo on github.com/${ghOwner}`
              : `Experiments push branches straight to ${repoLabel}`}
          </span>
        </>
      )}
      <div className="row2">
        <label>
          Project name
          <input
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            placeholder="my-research"
          />
        </label>
      </div>
    </>
  );

  return (
    <form className="form" onSubmit={submit}>
      <div className="seg form-seg">
        <button
          type="button"
          className={mode === "paper" ? "active" : ""}
          onClick={() => setMode("paper")}
        >
          From a paper
        </button>
        <button
          type="button"
          className={mode === "existing" ? "active" : ""}
          onClick={() => setMode("existing")}
        >
          Existing repo
        </button>
        <button
          type="button"
          className={mode === "new" ? "active" : ""}
          onClick={() => setMode("new")}
        >
          New blank repo
        </button>
      </div>

      {mode === "existing" && (
        <>
          <label>
            GitHub repository
            <input
              value={repoInput}
              onChange={(e) => onRepoChange(e.target.value)}
              placeholder="https://github.com/karpathy/nanoGPT"
              autoFocus
              spellCheck={false}
            />
            <span className={`repo-hint mono ${parsed ? "ok" : ""}`}>
              {parsed
                ? `${parsed.owner} / ${parsed.repo}`
                : repoInput.trim()
                  ? "Paste a GitHub URL or owner/repo"
                  : "URL or owner/repo — cloned with your git credentials"}
            </span>
          </label>
          {repoFields}
        </>
      )}

      {mode === "paper" &&
        (paper === null ? (
          <>
            <label>
              Paper
              <input
                value={paperQuery}
                onChange={(e) => setPaperQuery(e.target.value)}
                placeholder="arXiv id, URL, or title — e.g. 1706.03762"
                autoFocus
                spellCheck={false}
              />
              <span className={`repo-hint ${paperNote ? "" : "mono"}`}>
                {resolving
                  ? "Looking up paper…"
                  : searching
                    ? "Searching alphaXiv…"
                    : (paperNote ?? "Searches alphaXiv by title — or paste an arXiv id / URL")}
              </span>
            </label>
            {!paperNote && !resolving && !searching && (
              <span className="repo-hint">
                orx clones the code repo linked to the paper on alphaXiv.
              </span>
            )}
            {hits.length > 0 && (
              <div className="paper-results">
                {hits.map((h) => (
                  <button key={h.paperId} type="button" onClick={() => void selectPaper(h.paperId)}>
                    <span className="title">{cleanTitle(h.title)}</span>
                    <span className="id">{h.paperId}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="paper-pick">
              <div className="meta">
                <div className="title">{paper.title || paper.paperId}</div>
                <div className="id">arXiv {paper.paperId}</div>
              </div>
              <button type="button" className="btn ghost" onClick={clearPaper}>
                Change
              </button>
            </div>
            {/* Say outright whether the paper had code, so the repo field below
                is either "here's what we found" or "there wasn't one". */}
            <span className="repo-hint">
              {paper.repoUrl && parseRepo(paper.repoUrl) ? (
                <>
                  This paper links to <strong>{parseRepo(paper.repoUrl)!.owner}/
                  {parseRepo(paper.repoUrl)!.repo}</strong>
                  {paper.repoStars != null ? ` · ★ ${paper.repoStars}` : ""} — orx will clone it.
                </>
              ) : (
                <>
                  No code is linked to this paper on alphaXiv. Enter a repo yourself, or leave it
                  blank to start from a blank private repo.
                </>
              )}
            </span>
            <label>
              GitHub repository{paper.repoUrl ? "" : " (optional)"}
              <input
                value={repoInput}
                onChange={(e) => onRepoChange(e.target.value)}
                placeholder="owner/repo — leave blank for a new private repo"
                spellCheck={false}
              />
              <span className={`repo-hint mono ${parsed ? "ok" : ""}`}>
                {parsed
                  ? `${parsed.owner} / ${parsed.repo}` +
                    (paper.repoUrl && parseRepo(paper.repoUrl)?.repo === parsed.repo
                      ? ` · linked on alphaXiv${paper.repoStars != null ? ` · ★ ${paper.repoStars}` : ""}`
                      : "")
                  : repoInput.trim()
                    ? "Paste a GitHub URL or owner/repo"
                    : "No code linked to this paper — a blank private repo will be created"}
              </span>
            </label>
            {parsed ? (
              repoFields
            ) : (
              <label>
                Project name
                <input
                  value={name}
                  onChange={(e) => {
                    setNameTouched(true);
                    setName(e.target.value);
                  }}
                  placeholder="my-research"
                />
                <span className={`repo-hint mono ${name.trim() ? "ok" : ""}`}>
                  {name.trim()
                    ? `Creates github.com/${ghOwner}/${slugify(name)} · private`
                    : "A blank private repo is created on your GitHub account"}
                </span>
              </label>
            )}
          </>
        ))}

      {mode === "new" && (
        <label>
          Project name
          <input
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            placeholder="my-research"
            autoFocus
          />
          <span className={`repo-hint mono ${name.trim() ? "ok" : ""}`}>
            {name.trim()
              ? `Creates github.com/${ghOwner}/${slugify(name)} · private`
              : "A blank private repo is created on your GitHub account"}
          </span>
        </label>
      )}

      {error && <div className="error">{error}</div>}
      <div className="actions">
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn primary" disabled={!valid || pending}>
          {pending
            ? creatingRepo
              ? "Creating repo…"
              : repoMode === "fork"
                ? "Copying repo…"
                : "Cloning repo…"
            : "Create project"}
        </button>
      </div>
    </form>
  );
}
