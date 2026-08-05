import { useEffect, useRef, useState } from "react";
import {
  createProject,
  getProjectPathStatus,
  pickProjectFolder,
  resolvePaper,
  searchPapers,
  type PaperHit,
  type Project,
  type ProjectPathStatus,
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
  onCreated: (project: Project, githubPublicationError: string | null) => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("folder");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [path, setPath] = useState("");
  const [pathTouched, setPathTouched] = useState(false);
  const [pathStatus, setPathStatus] = useState<ProjectPathStatus | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const [checkingPath, setCheckingPath] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paperQuery, setPaperQuery] = useState("");
  const [paper, setPaper] = useState<ResolvedPaper | null>(null);
  const [hits, setHits] = useState<PaperHit[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const pathSeq = useRef(0);

  useEffect(() => {
    if (pathTouched || mode === "folder") return;
    setPath(`~/OpenResearch/${slugify(name)}`);
  }, [mode, name, pathTouched]);

  useEffect(() => {
    const request = ++pathSeq.current;
    setCheckingPath(true);
    setPathError(null);
    const timer = setTimeout(() => {
      void getProjectPathStatus(path.trim())
        .then((status) => {
          if (request === pathSeq.current) setPathStatus(status);
        })
        .catch((err) => {
          if (request !== pathSeq.current) return;
          setPathStatus(null);
          setPathError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (request === pathSeq.current) setCheckingPath(false);
        });
    }, path.trim() ? 200 : 0);
    return () => clearTimeout(timer);
  }, [path]);

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
            if (!nameTouched) setName(resolved.title?.trim().slice(0, 60) || resolved.paperId);
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
  }, [mode, paper, paperQuery, nameTouched]);

  async function choosePaper(paperId: string) {
    setSearching(true);
    setError(null);
    try {
      const resolved = await resolvePaper(paperId);
      setPaper(resolved);
      setHits([]);
      if (!nameTouched) setName(resolved.title?.trim().slice(0, 60) || resolved.paperId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  function changePaper() {
    seq.current += 1;
    setPaper(null);
    setPaperQuery("");
    setHits([]);
    setSearching(false);
    if (!nameTouched) setName("");
  }

  function chooseMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setError(null);
    setPathTouched(false);
    setPath(next === "folder" ? "" : `~/OpenResearch/${slugify(name)}`);
  }

  async function chooseLocalFolder() {
    if (pickingFolder) return;
    setPickingFolder(true);
    setError(null);
    try {
      const selected = await pickProjectFolder();
      if (!selected) return;
      setPathTouched(true);
      setPath(selected);
      if (!nameTouched) {
        const folderName = selected.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
        if (folderName) setName(folderName);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickingFolder(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    setPending(true);
    setError(null);
    try {
      const result = await createProject({
        name: name.trim(),
        path: path.trim(),
        createFolder: mode !== "folder",
        initializeGit: true,
        ...(mode === "paper" && paper
          ? { paperId: paper.paperId, cloneUrl: paper.repoUrl ?? undefined }
          : {}),
      });
      onCreated(result.project, result.githubPublicationError);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  const gitMissing = pathStatus?.gitVersion === null;
  const invalidLocalFolder =
    mode === "folder" &&
    Boolean(path.trim()) &&
    pathStatus !== null &&
    (pathStatus.exists === false || pathStatus.directory === false);
  const canCreate =
    Boolean(name.trim() && path.trim()) &&
    !pending &&
    !checkingPath &&
    !pathError &&
    !gitMissing &&
    !invalidLocalFolder &&
    (mode !== "paper" || paper !== null);

  return (
    <form className="form" onSubmit={submit}>
      <div className="seg form-seg">
        <button type="button" className={mode === "folder" ? "active" : ""} onClick={() => chooseMode("folder")}>
          Local folder
        </button>
        <button type="button" className={mode === "paper" ? "active" : ""} onClick={() => chooseMode("paper")}>
          From a paper
        </button>
        <button type="button" className={mode === "new" ? "active" : ""} onClick={() => chooseMode("new")}>
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
          <button type="button" className="btn sm" onClick={changePaper}>Change</button>
        </div>
      )}

      {(mode !== "paper" || paper) && (
        <>
          <label>
            Project name
            <input
              value={name}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
              placeholder="my-research"
            />
          </label>
          <label>
            Local folder
            {mode === "folder" ? (
              <div className="folder-picker-row">
                <input
                  value={path}
                  placeholder="Choose an existing folder"
                  readOnly
                  onClick={() => void chooseLocalFolder()}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={pickingFolder}
                  onClick={(event) => {
                    event.preventDefault();
                    void chooseLocalFolder();
                  }}
                >
                  {pickingFolder ? "Choosing…" : path ? "Change…" : "Choose…"}
                </button>
              </div>
            ) : (
              <>
                <input
                  value={path}
                  onChange={(event) => {
                    setPathTouched(true);
                    setPath(event.target.value);
                  }}
                  placeholder="~/OpenResearch/my-research"
                  spellCheck={false}
                />
                <span className="repo-hint mono">Created locally; GitHub is optional</span>
              </>
            )}
          </label>
          {gitMissing && (
            <div className="project-path-notice error">
              Git is required for experiments but is not installed. Install Git, then restart OpenResearch.
            </div>
          )}
          {!gitMissing && mode === "folder" && path.trim() && checkingPath && (
            <span className="repo-hint mono">Checking folder…</span>
          )}
          {!gitMissing && mode === "folder" && path.trim() && !checkingPath && pathStatus?.exists === false && (
            <div className="project-path-notice error">Choose an existing folder.</div>
          )}
          {!gitMissing && mode === "folder" && path.trim() && !checkingPath && pathStatus?.exists && pathStatus.directory === false && (
            <div className="project-path-notice error">The selected path is not a folder.</div>
          )}
          {!gitMissing && mode === "folder" && !checkingPath && pathStatus?.directory && pathStatus.initialized === false && (
            <div className="project-path-notice">
              This folder is not a Git repository. OpenResearch will initialize Git here.
            </div>
          )}
          {pathError && <div className="project-path-notice error">{pathError}</div>}
        </>
      )}

      {error && <div className="error">{error}</div>}
      <div className="actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={!canCreate}>
          {pending ? "Creating…" : "Create local project"}
        </button>
      </div>
    </form>
  );
}
