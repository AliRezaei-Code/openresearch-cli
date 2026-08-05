import { Plus, Trash2 } from "lucide-react";
import { Wordmark } from "./Wordmark";
import { useState } from "react";
import { deleteProject, timeAgo, type Project } from "../api";
import { NewProjectForm } from "./NewProjectForm";

export function ProjectsHome({
  projects,
  onOpen,
  onCreated,
  onDeleted,
}: {
  projects: Project[];
  onOpen: (id: string) => void;
  onCreated: (project: Project, githubPublicationError: string | null) => void;
  onDeleted: (id: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function onDelete(p: Project) {
    const hasGithubRepository = Boolean(p.githubUrl || (p.githubOwner && p.githubRepo));
    const ok = window.confirm(
      `Delete project "${p.name}"?\n\nIts experiments, runs and chats are removed from orx. ` +
        `The local folder (${p.path})${hasGithubRepository ? " and its GitHub repository" : ""} are kept.`,
    );
    if (!ok) return;
    setDeleting(p.id);
    try {
      await deleteProject(p.id);
      onDeleted(p.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-brand">
          <Wordmark />
        </div>
        <div className="home-head">
          <h2>Projects</h2>
          <button className="btn sm" onClick={() => setModalOpen(true)}>
            <Plus size={13} /> New project
          </button>
        </div>
        <div className="home-list">
          {projects.length === 0 ? (
            <div className="changes-note">No projects yet — create one to get started.</div>
          ) : (
            [...projects].sort((a, b) => b.updatedAt - a.updatedAt).map((p) => {
              const hasGithubRepository = Boolean(p.githubUrl || (p.githubOwner && p.githubRepo));
              const githubState = p.githubEnabled
                ? "GitHub syncing on"
                : hasGithubRepository
                  ? "GitHub syncing off"
                  : "local only";
              return (
              <div
                key={p.id}
                className="project-card"
                role="button"
                tabIndex={0}
                onClick={() => onOpen(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onOpen(p.id);
                }}
              >
                <span className="name">{p.name}</span>
                <span className="repo mono">
                  {p.path} · {p.baselineBranch} · {githubState}
                </span>
                {p.paperId && <span className="paper mono">arXiv {p.paperId}</span>}
                <span className="time">created {timeAgo(p.createdAt)}</span>
                <button
                  className="project-delete"
                  title={`Delete ${p.name}`}
                  disabled={deleting === p.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(p);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              );
            })
          )}
        </div>
      </div>

      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New project</h2>
            <NewProjectForm
              onCancel={() => setModalOpen(false)}
              onCreated={(project, githubPublicationError) => {
                setModalOpen(false);
                onCreated(project, githubPublicationError);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
