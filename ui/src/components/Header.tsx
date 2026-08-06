import {
  ArrowLeft,
  ChevronDown,
  FolderGit2,
  FolderPlus,
  History,
  PanelLeft,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { usePopover } from "./ModelPicker";

/** Top row of the agents rail: back to the projects page + the current
 *  project's name. Settings sections live in the rail nav below. */
export function RailHeader({
  projectName,
  onHome,
  onNewProject,
  onRepository,
  onCollapse,
}: {
  projectName: string;
  onHome: () => void;
  onNewProject: () => void;
  onRepository: () => void;
  /** Hide the rail (a matching reopen button lives in the chat header). */
  onCollapse?: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const projectButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const restoreFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") projectButtonRef.current?.focus();
    };
    document.addEventListener("keydown", restoreFocus, true);
    return () => document.removeEventListener("keydown", restoreFocus, true);
  }, [open]);

  return (
    <div className="rail-brand">
      <button
        className="icon-btn project-back"
        data-tip="All projects"
        data-tip-align="start"
        aria-label="All projects"
        onClick={onHome}
      >
        <ArrowLeft size={15} />
      </button>
      <div className="project-switcher" ref={ref}>
        <button
          ref={projectButtonRef}
          className={`brand${open ? " open" : ""}`}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="brand-project-copy">
            <span className="brand-project-label">Project</span>
            <span className="brand-project">{projectName}</span>
          </span>
          <ChevronDown className="project-chevron" size={14} />
        </button>
        {open && (
          <div className="option-menu drop-down project-menu">
            <button
              className="model-item"
              onClick={() => {
                setOpen(false);
                onRepository();
              }}
            >
              <span className="project-menu-label">
                <FolderGit2 size={14} />Configure Repository
              </span>
            </button>
            <button
              className="model-item"
              onClick={() => {
                setOpen(false);
                onHome();
              }}
            >
              <span className="project-menu-label"><History size={14} />All projects</span>
            </button>
            <button
              className="model-item"
              onClick={() => {
                projectButtonRef.current?.focus();
                setOpen(false);
                onNewProject();
              }}
            >
              <span className="project-menu-label"><FolderPlus size={14} />Create a new project</span>
            </button>
          </div>
        )}
      </div>
      {onCollapse && (
        <button
          className="icon-btn"
          data-tip="Hide sidebar"
          data-tip-align="end"
          aria-label="Hide sidebar"
          onClick={onCollapse}
        >
          <PanelLeft size={15} />
        </button>
      )}
    </div>
  );
}
