import { Blocks, Download, FileUp, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteUserSkill,
  fmtBytes,
  importHarnessSkill,
  listHarnessSkills,
  listUserSkills,
  uploadUserSkill,
  type HarnessSkill,
  type Project,
  type SkillScope,
  type UserSkill,
} from "../api";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Read a File into base64 (strips the `data:...;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("could not read file"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsDataURL(file);
  });
}

function isAcceptedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".zip");
}

function SkillRow({
  skill,
  projectId,
  onDeleted,
}: {
  skill: UserSkill;
  projectId?: string;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="skill-row">
      <div className="skill-row-main">
        <code className="skill-row-name">/{skill.name}</code>
        <p className="skill-row-desc">{skill.description}</p>
      </div>
      <span className="skill-row-size">{fmtBytes(skill.bytes)}</span>
      <button
        className="icon-btn"
        data-tip="Delete skill"
        data-tip-align="end"
        aria-label={`Delete skill ${skill.name}`}
        disabled={busy}
        onClick={() => {
          if (!window.confirm(`Delete the "${skill.name}" skill?`)) return;
          setBusy(true);
          deleteUserSkill({
            scope: skill.scope,
            name: skill.name,
            projectId: skill.scope === "project" ? projectId : undefined,
          })
            .then(onDeleted)
            .catch(() => setBusy(false));
        }}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function SkillList({
  title,
  hint,
  skills,
  projectId,
  onChanged,
}: {
  title: string;
  hint: string;
  skills: UserSkill[];
  projectId?: string;
  onChanged: () => void;
}) {
  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <h3>{title}</h3>
      </div>
      <p className="settings-sub">{hint}</p>
      {skills.length === 0 ? (
        <div className="skills-empty">No skills yet.</div>
      ) : (
        <div className="skill-list">
          {skills.map((s) => (
            <SkillRow key={s.name} skill={s} projectId={projectId} onDeleted={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

function HarnessSkillRow({
  skill,
  scopeLabel,
  alreadyImported,
  onImport,
}: {
  skill: HarnessSkill;
  scopeLabel: string;
  alreadyImported: boolean;
  onImport: (skill: HarnessSkill) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="skill-row">
      <div className="skill-row-main">
        <div className="skill-row-head">
          <code className="skill-row-name">/{skill.name}</code>
          <span className="skill-harness-badge">{skill.harnessName}</span>
        </div>
        <p className="skill-row-desc">{skill.description}</p>
      </div>
      <button
        className="skills-import-btn"
        disabled={busy}
        title={`Import into ${scopeLabel}`}
        onClick={async () => {
          setBusy(true);
          try {
            await onImport(skill);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <span className="spinner" /> : <Download size={13} />}
        {alreadyImported ? "Re-import" : "Import"}
      </button>
    </div>
  );
}

/** Middle-pane Skills tab — upload SKILL.md skills (single file or a zipped
 * folder) the agent auto-discovers in its session and the user invokes with
 * `/name`. Skills are Global (every project) or scoped to the open project. */
export function SkillsTab({ project }: { project: Project | null }) {
  const [skills, setSkills] = useState<UserSkill[] | null>(null);
  const [harnessSkills, setHarnessSkills] = useState<HarnessSkill[]>([]);
  const [scope, setScope] = useState<SkillScope>("global");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listUserSkills(project?.id)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [project?.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Installed-agent skills don't change on user actions, so fetch once.
  useEffect(() => {
    listHarnessSkills()
      .then(setHarnessSkills)
      .catch(() => setHarnessSkills([]));
  }, []);

  // Project scope is unavailable without an open project.
  useEffect(() => {
    if (!project && scope === "project") setScope("global");
  }, [project, scope]);

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      if (!isAcceptedName(file.name)) {
        setError("Upload a SKILL.md file or a .zip of a skill folder.");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError("File too large (max 20 MB).");
        return;
      }
      setBusy(true);
      try {
        const contentBase64 = await fileToBase64(file);
        await uploadUserSkill({
          scope,
          projectId: scope === "project" ? project?.id : undefined,
          filename: file.name,
          contentBase64,
        });
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [scope, project?.id, refresh],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  };

  const importSkill = useCallback(
    async (skill: HarnessSkill) => {
      setError(null);
      try {
        await importHarnessSkill({
          harness: skill.harnessId,
          name: skill.name,
          scope,
          projectId: scope === "project" ? project?.id : undefined,
        });
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [scope, project?.id, refresh],
  );

  const globalSkills = (skills ?? []).filter((s) => s.scope === "global");
  const projectSkills = (skills ?? []).filter((s) => s.scope === "project");
  const scopeLabel = scope === "global" ? "Global" : (project?.name ?? "this project");
  // Names present in the scope an import would target — for the "Re-import" hint.
  const existingInScope = new Set(
    (skills ?? []).filter((s) => s.scope === scope).map((s) => s.name),
  );

  return (
    <div className="settings-view skills-view">
      <h1>Skills</h1>
      <p className="skills-intro">
        Upload <code>SKILL.md</code> skills your agent discovers automatically in every session and
        you can invoke with <code>/name</code> in chat. Add a single <code>SKILL.md</code> or a{" "}
        <code>.zip</code> of a skill folder (with supporting scripts and resources).
      </p>

      <section className="settings-card">
        <div className="settings-card-head">
          <h3>Add a skill</h3>
        </div>

        <div className="skills-scope" role="group" aria-label="Skill scope">
          <button
            type="button"
            className={`skills-scope-btn ${scope === "global" ? "active" : ""}`}
            onClick={() => setScope("global")}
          >
            Global
            <span className="skills-scope-sub">Every project</span>
          </button>
          <button
            type="button"
            className={`skills-scope-btn ${scope === "project" ? "active" : ""}`}
            disabled={!project}
            title={project ? undefined : "Open a project to add a project skill"}
            onClick={() => setScope("project")}
          >
            This project
            <span className="skills-scope-sub">{project ? project.name : "No project open"}</span>
          </button>
        </div>

        <div
          className={`skills-dropzone ${dragging ? "dragging" : ""} ${busy ? "busy" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".md,.markdown,.zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
          {busy ? (
            <>
              <span className="spinner" />
              <span>Uploading…</span>
            </>
          ) : (
            <>
              <Upload size={20} strokeWidth={1.5} />
              <span>
                Drop a <code>SKILL.md</code> or <code>.zip</code> here, or click to choose
              </span>
              <span className="skills-dropzone-scope">
                <FileUp size={12} /> Adding to <strong>{scope === "global" ? "Global" : project?.name}</strong>
              </span>
            </>
          )}
        </div>

        {error && <div className="skills-error">{error}</div>}
      </section>

      {harnessSkills.length > 0 && (
        <section className="settings-card">
          <div className="settings-card-head">
            <h3>Import from your agent</h3>
          </div>
          <p className="settings-sub">
            Skills already installed in your coding agents. Import a copy into{" "}
            <strong>{scopeLabel}</strong> so it's managed here and invocable with <code>/name</code>.
          </p>
          <div className="skill-list">
            {harnessSkills.map((s) => (
              <HarnessSkillRow
                key={`${s.harnessId}:${s.name}`}
                skill={s}
                scopeLabel={scopeLabel}
                alreadyImported={existingInScope.has(s.name)}
                onImport={importSkill}
              />
            ))}
          </div>
        </section>
      )}

      {skills === null ? (
        <div className="settings-loading" style={{ padding: 12 }}>
          <span className="spinner" /> Loading skills…
        </div>
      ) : (
        <>
          <SkillList
            title="Global skills"
            hint="Available to the agent in every project."
            skills={globalSkills}
            onChanged={refresh}
          />
          {project && (
            <SkillList
              title={`${project.name} skills`}
              hint="Available only in this project's sessions. Shadows a global skill of the same name."
              skills={projectSkills}
              projectId={project.id}
              onChanged={refresh}
            />
          )}
        </>
      )}

      {skills !== null && skills.length === 0 && (
        <div className="skills-none-hint">
          <Blocks size={22} strokeWidth={1.5} />
          <span>No skills uploaded yet. Add one above to get started.</span>
        </div>
      )}
    </div>
  );
}
