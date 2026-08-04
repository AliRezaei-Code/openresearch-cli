import { useEffect, useRef, useState } from "react";
import {
  createProject,
  resolvePaper,
  searchPapers,
  type PaperHit,
  type Project,
  type ResolvedPaper,
} from "../api";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "research-project"
  );
}

function parsePaperId(input: string): string | null {
  const last = input.trim().split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
  const id = last.replace(/\.(pdf|md)$/i, "");
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(id) ? id : null;
}

type Mode = "folder" | "new" | "paper";

export function NewProjectForm({
  onCreated,
  onCancel,
}: {
  onCreated: (project: Project) => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("folder");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [pathTouched, setPathTouched] = useState(false);
  const [initializeGit, setInitializeGit] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paperQuery, setPaperQuery] = useState("");
  const [paper, setPaper] = useState<ResolvedPaper | null>(null);
  const [hits, setHits] = useState<PaperHit[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (pathTouched || mode === "folder") return;
    setPath(`~/OpenResearch/${slugify(name)}`);
  }, [mode, name, pathTouched]);

  useEffect(() => {
    const request = ++seq.current;
    if (mode !== "paper" || paper) {
      setSearching(false);
      return;
    }
    const query = paperQuery.trim();
    const id = parsePaperId(query);
    if (!id && query.length < 3) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      if (id) {
        void resolvePaper(id)
          .then((resolved) => {
            if (request !== seq.current) return;
            setPaper(resolved);
            if (!name.trim()) setName(resolved.title?.trim().slice(0, 60) || resolved.paperId);
          })
          .catch((err) => request === seq.current && setError(err instanceof Error ? err.message : String(err)))
          .finally(() => request === seq.current && setSearching(false));
        return;
      }
      void searchPapers(query)
        .then((results) => request === seq.current && setHits(results))
        .catch((err) => request === seq.current && setError(err instanceof Error ? err.message : String(err)))
        .finally(() => request === seq.current && setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, paper, paperQuery, name]);

  async function choosePaper(paperId: string) {
    setSearching(true);
    setError(null);
    try {
      const resolved = await resolvePaper(paperId);
      setPaper(resolved);
      setHits([]);
      if (!name.trim()) setName(resolved.title?.trim().slice(0, 60) || resolved.paperId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !path.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        path: path.trim(),
        createFolder: mode !== "folder",
        initializeGit: mode !== "folder" || initializeGit,
        ...(mode === "paper" && paper
          ? { paperId: paper.paperId, cloneUrl: paper.repoUrl ?? undefined }
          : {}),
      });
      onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="seg form-seg">
        <button type="button" className={mode === "folder" ? "active" : ""} onClick={() => setMode("folder")}>
          Local folder
        </button>
        <button type="button" className={mode === "paper" ? "active" : ""} onClick={() => setMode("paper")}>
          From a paper
        </button>
        <button type="button" className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>
          New folder
        </button>
      </div>

      {mode === "paper" && !paper && (
        <label>
          Paper
          <input
            value={paperQuery}
            onChange={(event) => setPaperQuery(event.target.value)}
            placeholder="arXiv id, URL, or title"
            autoFocus
          />
          <span className="repo-hint">{searching ? "Searching alphaXiv…" : "The public code repository is cloned without credentials."}</span>
          {hits.length > 0 && (
            <div className="paper-results">
              {hits.map((hit) => (
                <button key={hit.paperId} type="button" onClick={() => void choosePaper(hit.paperId)}>
                  <span className="title">{hit.title}</span>
                  <span className="id">{hit.paperId}</span>
                </button>
              ))}
            </div>
          )}
        </label>
      )}

      {paper && mode === "paper" && (
        <div className="paper-pick">
          <div className="meta">
            <div className="title">{paper.title || paper.paperId}</div>
            <div className="id">{paper.repoUrl ? "Public repository will be kept as upstream" : "No code repository found; a local Git repository will be initialized"}</div>
          </div>
          <button type="button" className="btn sm" onClick={() => setPaper(null)}>Change</button>
        </div>
      )}

      {(mode !== "paper" || paper) && (
        <>
          <label>
            Project name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-research" />
          </label>
          <label>
            Local folder
            <input
              value={path}
              onChange={(event) => {
                setPathTouched(true);
                setPath(event.target.value);
              }}
              placeholder={mode === "folder" ? "/path/to/project" : "~/OpenResearch/my-research"}
              spellCheck={false}
            />
            <span className="repo-hint mono">
              {mode === "folder" ? "Existing files stay in place" : "Created locally; GitHub is optional"}
            </span>
          </label>
          {mode === "folder" && (
            <label className="check-row">
              <input type="checkbox" checked={initializeGit} onChange={(event) => setInitializeGit(event.target.checked)} />
              Initialize Git if this folder is not already a repository
            </label>
          )}
        </>
      )}

      {error && <div className="error">{error}</div>}
      <div className="actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={!name.trim() || !path.trim() || pending || (mode === "paper" && !paper)}>
          {pending ? "Creating…" : "Create local project"}
        </button>
      </div>
    </form>
  );
}
