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
  // The signed-in GitHub login, so previews name the real account. Falls back
  // to "you" when there's no usable token.
  const [ghLogin, setGhLogin] = useState<string | null>(null);
  useEffect(() => {
    void githubAccount()
      .then((r) => setGhLogin(r.login))
      .catch(() => setGhLogin(null));
  }, []);
  const ghOwner = ghLogin ?? "you";

  const parsed = parseRepo(repoInput);
  const valid = Boolean(
    name.trim() &&
      (mode === "new" ||
        (mode === "existing" && parsed !== null) ||
        (mode === "paper" && paper !== null && (repoInput.trim() === "" || parsed !== null))),
  );

  // Leaving paper mode carries the paper's repo over into the field, but not
  // its deliberate copy default — the user never chose that for this mode, and
  // a pre-filled field means onRepoChange never fires to reset it.
  const chooseMode = (next: Mode) => {
    setMode(next);
    if (next !== "paper") setRepoMode("use");
  };

  const onRepoChange = (value: string) => {
    setRepoInput(value);
    // A forced copy belonged to the old repo — start the new one back at the
    // default so an unpushable repo can't leave "Private copy" stuck on. Keyed
    // on the mode, not on `paper`: a leftover paper selection would otherwise
    // suppress the reset after switching to "Existing repo". In paper mode
    // selectPaper deliberately defaults to a copy, and editing the auto-filled
    // repo shouldn't quietly retarget pushes upstream.
    if (mode !== "paper") setRepoMode("use");
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
      return;
    }
    const [owner, repo] = repoKey.split("/");
    // null means "asking" — reset so a previous repo's answer never describes
    // this one while the check is in flight.
    setCanPush(null);
    let live = true;
    const t = setTimeout(() => {
      repoAccess(owner, repo)
        .then((r) => {
          if (!live) return;
          setCanPush(r.canPush);
          // Only force the copy — the server does too, without push access.
          // Never force "use": that would undo selectPaper's deliberate
          // fork default for the rare writable paper repo.
          if (!r.canPush) setRepoMode("fork");
        })
        .catch(() => {
          // Unreachable check: assume access, matching the server's fallback.
          if (live) setCanPush(true);
        });
    }, 400);
    // `live` alone drops superseded responses — the cleanup runs before the
    // next effect, so no sequence counter is needed.
    return () => {
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
  const repoFields = !parsed ? null : canPush === null ? (
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
    </>
  );

  // Outside repoFields: the name doesn't depend on repo access, so a stalled
  // check can't leave the form unsubmittable.
  const nameField = (autoFocus = false) => (
    <label>
      Project name
      <input
        value={name}
        onChange={(e) => {
          setNameTouched(true);
          setName(e.target.value);
        }}
        placeholder="my-research"
        autoFocus={autoFocus}
      />
    </label>
  );

  // Shown wherever a blank repo is what gets created.
  const blankRepoHint = (
    <span className={`repo-hint mono ${name.trim() ? "ok" : ""}`}>
      {name.trim()
        ? `Creates github.com/${ghOwner}/${slugify(name)} · private`
        : "A blank private repo is created on your GitHub account"}
    </span>
  );

  return (
    <form className="form" onSubmit={submit}>
      <div className="seg form-seg">
        <button
          type="button"
          className={mode === "paper" ? "active" : ""}
          onClick={() => chooseMode("paper")}
        >
          From a paper
        </button>
        <button
          type="button"
          className={mode === "existing" ? "active" : ""}
          onClick={() => chooseMode("existing")}
        >
          Existing repo
        </button>
        <button
          type="button"
          className={mode === "new" ? "active" : ""}
          onClick={() => chooseMode("new")}
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
          {parsed && nameField}
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
            {parsed && repoFields}
            {nameField()}
            {!parsed && blankRepoHint}
          </>
        ))}

      {mode === "new" && (
        <>
          {nameField(true)}
          {blankRepoHint}
        </>
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
