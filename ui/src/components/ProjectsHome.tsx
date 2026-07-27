import { Plus, Trash2 } from "lucide-react";
import { Wordmark } from "./Wordmark";
import { useEffect, useState } from "react";
import { deleteProject, timeAgo, type Project } from "../api";
import { NewProjectForm } from "./NewProjectForm";

export function ProjectsHome({
  projects,
  onOpen,
  onCreated,
  onDeleted,
  openNewProject = false,
  onNewProjectOpened,
}: {
  projects: Project[];
  onOpen: (id: string) => void;
  onCreated: (project: Project) => void;
  onDeleted: (id: string) => void;
  /** Open the New project modal on mount — onboarding ends on "Create your
   * first project", so landing behind an empty page would ask for that click
   * twice. Only the post-onboarding hand-off sets this. */
  openNewProject?: boolean;
  /** Clear the hand-off flag, so a later remount doesn't re-open the modal. */
  onNewProjectOpened?: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(openNewProject);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Consume the hand-off once: the flag lives in App, and leaving it set would
  // re-open the modal on any later remount of this page.
  useEffect(() => {
    if (openNewProject) onNewProjectOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onDelete(p: Project) {
    const ok = window.confirm(
      `Delete project "${p.name}"?\n\nIts experiments, runs and chats are removed from orx. ` +
        `The GitHub repo (${p.githubOwner}/${p.githubRepo}) is kept.`,
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
            [...projects].sort((a, b) => b.updatedAt - a.updatedAt).map((p) => (
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
                  {p.githubOwner}/{p.githubRepo} · {p.baselineBranch}
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
            ))
          )}
        </div>
      </div>

      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New project</h2>
            <NewProjectForm
              onCancel={() => setModalOpen(false)}
              onCreated={(p) => {
                setModalOpen(false);
                onCreated(p);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
