import {
  ChartSpline,
  Check,
  FileCode,
  Filter,
  FlaskConical,
  FolderGit2,
  FolderTree,
  Maximize2,
  Minimize2,
  ScrollText,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelRun,
  DEMO_FIGURE_SESSION_ID,
  DEMO_LITERATURE_SESSION_ID,
  DEMO_PROJECT_ID,
  getArtifacts,
  listExperiments,
  listChatSessions,
  listProjects,
  listRuns,
  openProject,
  type Experiment,
  type ProjectArtifacts,
  type Project,
  type Run,
} from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { SubagentTab } from "./components/SubagentTab";
import { CodeTab, type CodeView } from "./components/CodeTab";
import { WorktreeTab, type WorktreeView } from "./components/WorktreeTab";
import { ArtifactsTab } from "./components/ArtifactsTab";
import { ClosableTab } from "./components/ClosableTab";
import { DetailDrawer, type ExperimentView } from "./components/DetailDrawer";
import { FileViewer } from "./components/FileViewer";
import { RailHeader } from "./components/Header";
import { Onboarding } from "./components/Onboarding";
import { NewProjectDialog, ProjectsHome } from "./components/ProjectsHome";
import { ExperimentsTable } from "./components/ExperimentsTable";
import { Md } from "./components/Md";
import { usePopover } from "./components/ModelPicker";
import { SettingsView, type SettingsTab } from "./components/SettingsPage";
import { Tour, TOUR_DONE_KEY } from "./components/Tour";
import { clearReadDemoSessions } from "./demoSessionState";
import { TreeView } from "./components/TreeView";
import { useOrxEvents } from "./events";
import { saveAgentSelection } from "./agentSelection";

/** An experiment view open as a right-panel tab. */
interface ExpViewDef {
  id: string;
  view: ExperimentView;
}

const sameExpTab = (a: ExpViewDef, b: ExpViewDef) => a.id === b.id && a.view === b.view;

/** A project file open as a right-panel tab (clicked in chat tool rows or the
 * code browser). */
interface FileViewDef {
  path: string;
  /** Which backend serves this file. Absent/"repo" → the repo `/file`
   * endpoint (worktree/clone/branch), falling back to artifacts when a
   * non-ref path misses the checkout; "artifacts" → the project's durable
   * output directory through the compatibility `/files/file` endpoint. */
  source?: "repo" | "artifacts";
  /** Chat session whose worktree holds the file (absent → hub clone).
   * Artifact tabs never carry this. */
  sessionId?: string;
  /** Branch whose committed copy to show (code browser in branch mode);
   * overrides the live checkout. */
  ref?: string;
  /** 1-based line to scroll to and highlight on open (from a `file:line`
   * evidence chip). Not part of tab identity — reopening at a new line updates
   * the same tab. */
  line?: number;
}

const sameFileTab = (a: FileViewDef, b: FileViewDef) =>
  a.path === b.path &&
  (a.source ?? "repo") === (b.source ?? "repo") &&
  a.sessionId === b.sessionId &&
  a.ref === b.ref;

const fileTabKey = (t: FileViewDef) =>
  `${t.source ?? "repo"}:${t.sessionId ?? ""}:${t.ref ?? ""}:${t.path}`;

/** A proposed plan open as a right-panel tab (from the chat plan strip/card).
 * The markdown is already client-side (it rode the prompt part), so the tab
 * renders it directly — no fetch. Deliberately has neither a `view` nor a
 * `path` field: the other tab kinds discriminate on those. */
interface PlanViewDef {
  kind: "plan";
  sessionId: string;
  /** The prompt part the plan came from — one tab per plan card. */
  promptId: string;
  plan: string;
}

/** A sub-agent's transcript, opened from a chat spawn row's "view" button. One
 * tab per spawn part; its parts stream live off the session's chat message. */
interface SubagentViewDef {
  kind: "subagent";
  sessionId: string;
  /** The `subagent` spawn part whose `children` are the sub-agent transcript. */
  spawnPartId: string;
}

/** One committed code-browser tab per experiment branch. Source, selected
 * view, and expansion state live here so they survive tab switches. */
interface CodeTabDef {
  code: true;
  experimentId: string;
  branch: string;
  view: CodeView;
  /** Dirs the user flipped away from their depth default. */
  toggled: ReadonlySet<string>;
}

const sameCodeTab = (a: CodeTabDef, b: CodeTabDef) => a.branch === b.branch;

type RightTab =
  | "experiments"
  | "files"
  | ExpViewDef
  | FileViewDef
  | PlanViewDef
  | SubagentViewDef
  | CodeTabDef;

interface RightPaneSessionState {
  rightTab: RightTab;
  experimentsTabOpen: boolean;
  filesTabOpen: boolean;
  expTabs: ExpViewDef[];
  fileTabs: FileViewDef[];
  planTabs: PlanViewDef[];
  subagentTabs: SubagentViewDef[];
  codeTabs: CodeTabDef[];
  filesView: WorktreeView;
  filesToggled: ReadonlySet<string>;
  selectedRunId: string | null;
  scope: "agent" | "project";
  panelOpen: boolean;
  panelMax: boolean;
}

function initialRightPaneSessionState(sessionId?: string): RightPaneSessionState {
  const initial: RightPaneSessionState = {
    rightTab: "experiments",
    experimentsTabOpen: true,
    filesTabOpen: false,
    expTabs: [],
    fileTabs: [],
    planTabs: [],
    subagentTabs: [],
    codeTabs: [],
    filesView: "files",
    filesToggled: new Set(),
    selectedRunId: null,
    scope: "project",
    panelOpen: true,
    panelMax: false,
  };
  if (sessionId === DEMO_FIGURE_SESSION_ID) {
    const fileTabs: FileViewDef[] = [
      { path: "nanochat-base-training-curves.svg", source: "artifacts" },
      { path: "nanochat-sft-training-curves.svg", source: "artifacts" },
      { path: "nanochat-training-throughput.svg", source: "artifacts" },
      { path: "nanochat-core-evaluation.svg", source: "artifacts" },
    ];
    return { ...initial, rightTab: fileTabs[0], experimentsTabOpen: false, fileTabs };
  }
  if (sessionId === DEMO_LITERATURE_SESSION_ID) {
    const fileTabs: FileViewDef[] = [
      { path: "nanochat-bottleneck-diagnosis.md", source: "artifacts" },
    ];
    return { ...initial, rightTab: fileTabs[0], experimentsTabOpen: false, fileTabs };
  }
  return initial;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Map a path an agent reported to a right-pane file tab. An artifact path under
// the compatibility <data dir>/files/<slug>/ layout is stripped to a relative
// path and tagged source:"artifacts". Otherwise it's a repo/worktree path stripped to
// repo-relative, keeping the session id when it points into a per-session
// worktree. Relative paths name files in the click context's checkout and
// inherit `contextSessionId`; the regex fallbacks encode the
// ~/.cache/openresearch/ layouts from src/local/git.rs:
// worktrees/<project-id>/<session>/… and the legacy repos/<owner>/<repo>/….
function parseFilePath(
  rawPath: string,
  repoPath?: string,
  contextSessionId?: string,
  artifactsDir?: string,
  slug?: string,
): FileViewDef | null {
  let path = rawPath;
  let sessionId: string | undefined;
  const clone = repoPath?.replace(/\/+$/, "");
  const artifacts = artifactsDir?.replace(/\/+$/, "");
  if (path.startsWith("artifacts/")) {
    path = path.slice("artifacts/".length);
    return path ? { path, source: "artifacts" } : null;
  }
  if (!path.startsWith("/")) {
    sessionId = contextSessionId;
  } else if (artifacts && (path === artifacts || path.startsWith(`${artifacts}/`))) {
    // Artifact — exact prefix match against the non-canonical dir the
    // backend surfaced, which mirrors what the agent inlines.
    const rel = path.slice(artifacts.length).replace(/^\/+/, "");
    return rel ? { path: rel, source: "artifacts" } : null;
  } else if (clone && (path === clone || path.startsWith(`${clone}/`))) {
    path = path.slice(clone.length).replace(/^\/+/, "");
  } else {
    // Artifact fallback for a symlink-divergent path (e.g. /tmp vs
    // /private/tmp) where the exact prefix missed: match the …/files/<slug>/<rel>
    // layout, requiring the slug segment when we know it. (Legacy artifacts/ is
    // migrated to files/ in place, so it never appears in a live path.)
    const slugPat = slug ? escapeRegExp(slug) : "[^/]+";
    const fd = path.match(new RegExp(`/files/${slugPat}/(.+)$`));
    const wt = fd ? null : path.match(/\/openresearch\/worktrees\/[^/]+\/([^/]+)\/(.+)$/);
    const hub = fd || wt ? null : path.match(/\/openresearch\/repos\/[^/]+\/[^/]+\/(.+)$/);
    if (fd) {
      return { path: fd[1], source: "artifacts" };
    } else if (wt) {
      sessionId = wt[1];
      path = wt[2];
    } else if (hub) {
      path = hub[1];
    }
  }
  return path ? { path, sessionId } : null;
}

/** The git branch a code file tab is showing, for the header pill — a cited
 * experiment's branch (or any ref view) names that branch, and a worktree/clone
 * file falls back to the baseline branch, so a code tab always says which
 * branch its contents came from. Artifacts have no branch. */
function fileBranchLabel(tab: FileViewDef, baselineBranch?: string): string | undefined {
  if (tab.source === "artifacts") return undefined;
  return tab.ref ?? baselineBranch;
}

const ONBOARDED_KEY = "orx:onboarded";
const PANEL_WIDTH_KEY = "orx:panel-width";
const EXPERIMENTS_VIEW_KEY = "orx:experiments-view";

type ExperimentsView = "tree" | "table";

function initialExperimentsView(): ExperimentsView {
  try {
    return localStorage.getItem(EXPERIMENTS_VIEW_KEY) === "tree" ? "tree" : "table";
  } catch {
    return "table";
  }
}

/** Floating panel sizing: keep both the panel and the chat column usable. */
const PANEL_MIN_WIDTH = 360;
const PANEL_MARGIN = 10;
// Space the rest of the layout needs beside the panel: the 272px rail, the
// chat column's minimum, and the gutters/margins between the three columns
// (app-body padding 14×2, rail inner margin 14, right-pane inner margin 14).
const RAIL_WIDTH = 272;
const CHAT_MIN_SPACE = 380;
const LAYOUT_CHROME = RAIL_WIDTH + 14 * 4;
// Once a drag pushes the panel past its usable max by this much, it snaps to
// fullscreen — a bit of resistance you have to overcome deliberately.
const FULLSCREEN_SNAP_SLOP = 80;

/** The widest the floating panel can be while leaving the rail + chat usable. */
function panelMaxWidth(): number {
  return Math.max(PANEL_MIN_WIDTH, window.innerWidth - LAYOUT_CHROME - CHAT_MIN_SPACE);
}

function initialPanelWidth(): number {
  const max = panelMaxWidth();
  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= PANEL_MIN_WIDTH) return Math.min(saved, max);
  } catch {
    // storage unavailable — fall through to the default
  }
  return Math.max(PANEL_MIN_WIDTH, Math.min(760, max, Math.round(window.innerWidth * 0.42)));
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  // Latest runs, read by the stable openRunLogs so run-evidence chips resolve a
  // runId to its experiment without re-creating the callback on every poll.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const [artifacts, setArtifacts] = useState<ProjectArtifacts | null>(null);
  const [view, setView] = useState<ExperimentsView>(initialExperimentsView);
  // Experiments pane scope: "agent" narrows to the open chat session's work.
  // Falls back to "project" whenever there is no usable experiment attribution.
  const [scope, setScope] = useState<"agent" | "project">("project");
  const scopeTriggerRef = useRef<HTMLButtonElement>(null);
  const { open: scopeMenuOpen, setOpen: setScopeMenuOpen, ref: scopeMenuRef } =
    usePopover(scopeTriggerRef);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const allExperimentsAttributed = experiments.every((experiment) => experiment.chatSessionId);
  const effectiveScope = activeSessionId && allExperimentsAttributed ? scope : "project";
  const scopedExperiments = useMemo(() => {
    if (effectiveScope !== "agent") return experiments;
    return experiments.filter((experiment) => experiment.chatSessionId === activeSessionId);
  }, [experiments, effectiveScope, activeSessionId]);
  // Runs are scoped by their experiment's owner, not by which session launched them.
  const scopedRuns = useMemo(() => {
    if (effectiveScope !== "agent") return runs;
    const mine = new Set(scopedExperiments.map((experiment) => experiment.id));
    return runs.filter((r) => mine.has(r.experimentId));
  }, [runs, scopedExperiments, effectiveScope]);
  useEffect(() => {
    try {
      localStorage.setItem(EXPERIMENTS_VIEW_KEY, view);
    } catch {
      // The preference remains sticky for this app session when storage is unavailable.
    }
  }, [view]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Right-panel tab strip: closable home and working tabs. The same experiment
  // can keep both its overview and terminal open.
  const [rightTab, setRightTab] = useState<RightTab>("experiments");
  const [experimentsTabOpen, setExperimentsTabOpen] = useState(true);
  const [filesTabOpen, setFilesTabOpen] = useState(false);
  const [expTabs, setExpTabs] = useState<ExpViewDef[]>([]);
  const [fileTabs, setFileTabs] = useState<FileViewDef[]>([]);
  const [planTabs, setPlanTabs] = useState<PlanViewDef[]>([]);
  const [subagentTabs, setSubagentTabs] = useState<SubagentViewDef[]>([]);
  const [codeTabs, setCodeTabs] = useState<CodeTabDef[]>([]);
  const [filesView, setFilesView] = useState<WorktreeView>("files");
  const [filesToggled, setFilesToggled] = useState<ReadonlySet<string>>(new Set());
  // The right pane is a floating panel: closable, edge-resizable, expandable
  // to (nearly) full screen. Width persists across sessions.
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelMax, setPanelMax] = useState(false);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  // The agents rail is a floating panel too: fixed-width, collapsible.
  const [railOpen, setRailOpen] = useState(true);
  const [homeOpen, setHomeOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // What the middle pane shows: the agent chat, project artifacts, or
  // one settings section (picked from the rail nav — no separate pages).
  const [mainView, setMainView] = useState<"chat" | "artifacts" | SettingsTab>("chat");
  const [githubPublicationError, setGithubPublicationError] = useState<{
    projectId: string;
    message: string;
  } | null>(null);
  const rightPaneStatesRef = useRef(new Map<string, RightPaneSessionState>());
  const currentRightPaneStateRef = useRef<RightPaneSessionState>(initialRightPaneSessionState());
  const activeSessionIdRef = useRef<string | null>(null);
  currentRightPaneStateRef.current = {
    rightTab,
    experimentsTabOpen,
    filesTabOpen,
    expTabs,
    fileTabs,
    planTabs,
    subagentTabs,
    codeTabs,
    filesView,
    filesToggled,
    selectedRunId,
    scope,
    panelOpen,
    panelMax,
  };
  const onActiveSessionChange = useCallback((nextSessionId: string | null) => {
    const previousSessionId = activeSessionIdRef.current;
    if (previousSessionId === nextSessionId) return;
    if (previousSessionId) {
      rightPaneStatesRef.current.set(previousSessionId, currentRightPaneStateRef.current);
    }
    const nextState = nextSessionId
      ? (rightPaneStatesRef.current.get(nextSessionId) ??
        initialRightPaneSessionState(nextSessionId))
      : initialRightPaneSessionState();
    setRightTab(nextState.rightTab);
    setExperimentsTabOpen(nextState.experimentsTabOpen);
    setFilesTabOpen(nextState.filesTabOpen);
    setExpTabs(nextState.expTabs);
    setFileTabs(nextState.fileTabs);
    setPlanTabs(nextState.planTabs);
    setSubagentTabs(nextState.subagentTabs);
    setCodeTabs(nextState.codeTabs);
    setFilesView(nextState.filesView);
    setFilesToggled(nextState.filesToggled);
    setSelectedRunId(nextState.selectedRunId);
    setScope(nextState.scope);
    setPanelOpen(nextState.panelOpen);
    setPanelMax(nextState.panelMax);
    activeSessionIdRef.current = nextSessionId;
    setActiveSessionId(nextSessionId);
  }, []);
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem(ONBOARDED_KEY) === "1";
    } catch {
      return true; // storage unavailable — don't loop the walkthrough
    }
  });
  // The spotlight tour of the workspace (Tour.tsx). Starting it normalizes
  // the layout so every tour target exists; those are the defaults, so
  // nothing needs restoring on finish/skip.
  const [tourOpen, setTourOpen] = useState(false);
  const startTour = useCallback(() => {
    setMainView("chat");
    setRailOpen(true);
    setExperimentsTabOpen(true);
    setRightTab("experiments");
    setPanelOpen(true);
    setPanelMax(false);
    setTourOpen(true);
  }, []);
  const closeTour = useCallback(() => {
    try {
      localStorage.setItem(TOUR_DONE_KEY, "1");
    } catch {
      // private mode etc. — the tour just replays next boot
    }
    setTourOpen(false);
  }, []);

  // Auto-start the tour the first time the workspace is actually on screen:
  // first-run walkthrough done, a project open, projects home closed. With
  // zero projects this waits until the first one is created and opened.
  useEffect(() => {
    if (!projectId || homeOpen || !onboarded) return;
    try {
      if (localStorage.getItem(TOUR_DONE_KEY) === "1") return;
    } catch {
      return; // storage unavailable — don't loop the tour
    }
    startTour();
  }, [projectId, homeOpen, onboarded, startTour]);

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Initial project list.
  useEffect(() => {
    listProjects()
      .then(async (list) => {
        if (import.meta.env.DEV && list.length === 0) {
          try {
            localStorage.removeItem(TOUR_DONE_KEY);
          } catch {
            // The tour will start from in-memory state when storage is unavailable.
          }
          clearReadDemoSessions();
          setOnboarded(false);
        }
        const demo = list.find((project) => project.id === DEMO_PROJECT_ID);
        const recoveredDemo = !onboarded ? demo : undefined;
        if (recoveredDemo) {
          const session = (await listChatSessions(recoveredDemo.id))[0];
          if (!session) throw new Error("The seeded demo conversation is missing.");
          saveAgentSelection({
            harness: session.harness,
            model: session.model,
            permissionMode: session.permissionMode,
            reasoningLevel: session.reasoningLevel,
          });
          setOnboarded((current) => {
            if (current) return current;
            try {
              localStorage.setItem(ONBOARDED_KEY, "1");
            } catch {
              // The server-side demo row remains the durable completion marker.
            }
            return true;
          });
        }
        setProjects(list);
        setProjectId((cur) => cur ?? recoveredDemo?.id ?? list[0]?.id ?? null);
      })
      .catch(() => setProjects([]));
  }, []);

  // Shrinking the window can push a fixed-width panel past its usable max —
  // reclamp so it never overflows the viewport.
  useEffect(() => {
    const onResize = () => setPanelWidth((w) => Math.min(w, panelMaxWidth()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Per-project data. Harness agents spawn lazily on the first chat message.
  useEffect(() => {
    if (!projectId) return;
    const previousSessionId = activeSessionIdRef.current;
    if (previousSessionId) {
      rightPaneStatesRef.current.set(previousSessionId, currentRightPaneStateRef.current);
    }
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    // Record the visit; the resulting project.updated SSE event refreshes the
    // list's recency order.
    openProject(projectId).catch(() => {});
    setExperiments([]);
    setRuns([]);
    setArtifacts(null);
    setSelectedRunId(null);
    setExpTabs([]);
    setFileTabs([]);
    setPlanTabs([]);
    setSubagentTabs([]);
    setCodeTabs([]);
    setFilesView("files");
    setFilesToggled(new Set());
    setRightTab("experiments");
    setExperimentsTabOpen(true);
    setFilesTabOpen(false);
    // Scoping is an explicit per-project choice — don't let Current task scope
    // re-bind to whichever session ChatPanel auto-selects in the next project.
    setScope("project");
    listExperiments(projectId).then(setExperiments).catch(() => {});
    listRuns(projectId).then(setRuns).catch(() => {});
    getArtifacts(projectId).then(setArtifacts).catch(() => {});
  }, [projectId]);

  // Refetch artifacts on open and whenever the directory changes.
  const refreshArtifacts = useCallback(() => {
    const id = projectIdRef.current;
    if (id) getArtifacts(id).then(setArtifacts).catch(() => {});
  }, []);

  // Live store updates.
  useOrxEvents({
    onRun: (run) => {
      if (run.projectId === projectIdRef.current) setRuns((cur) => upsert(cur, run));
    },
    onExperiment: (experiment) => {
      if (experiment.projectId === projectIdRef.current)
        setExperiments((cur) => upsert(cur, experiment));
    },
    onProject: (project) => {
      setProjects((cur) => (cur ? upsert(cur, project) : [project]));
    },
    onArtifacts: (pid) => {
      if (pid === projectIdRef.current) refreshArtifacts();
    },
  });

  // Stable identity: in TreeView's layout-memo deps, so an inline arrow would
  // recompute the graph on every render.
  const showProjectScope = useCallback(() => setScope("project"), []);

  // Open an experiment view as a right-panel tab (creating it if needed) and
  // focus it.
  const openExperimentTab = useCallback((id: string, view: ExperimentView = "overview") => {
    const tab = { id, view };
    setExpTabs((prev) => (prev.some((t) => sameExpTab(t, tab)) ? prev : [...prev, tab]));
    setRightTab(tab);
    setPanelOpen(true);
  }, []);

  // A `<run>` evidence chip in chat opens that run's logs — the only evidence
  // channel for a metric. Run ids are globally unique, so resolve the run to its
  // experiment and open the terminal view focused on it.
  const openRunLogs = useCallback(
    (runId: string) => {
      const run = runsRef.current.find((r) => r.id === runId);
      if (!run) return;
      setSelectedRunId(runId);
      openExperimentTab(run.experimentId, "terminal");
    },
    [openExperimentTab],
  );

  const closeExperimentTab = useCallback(
    (tab: ExpViewDef) => {
      const idx = expTabs.findIndex((t) => sameExpTab(t, tab));
      if (idx === -1) return;
      const next = expTabs.filter((_, i) => i !== idx);
      setExpTabs(next);
      if (typeof rightTab === "object" && "id" in rightTab && sameExpTab(rightTab, tab)) {
        const fallback =
          next[Math.min(idx, next.length - 1)] ??
          (experimentsTabOpen ? "experiments" : undefined) ??
          (filesTabOpen ? "files" : undefined) ??
          fileTabs[0] ??
          planTabs[0] ??
          subagentTabs[0] ??
          codeTabs[0];
        if (fallback) setRightTab(fallback);
        else {
          setPanelOpen(false);
          setPanelMax(false);
        }
      }
    },
    [
      expTabs,
      rightTab,
      experimentsTabOpen,
      filesTabOpen,
      fileTabs,
      planTabs,
      subagentTabs,
      codeTabs,
    ],
  );

  // Open a project file as a right-panel tab. `contextSessionId` is the chat
  // session (or viewed file's session) the click came from — see
  // parseFilePath for how it resolves against the reported path.
  const openFileTab = useCallback(
    (rawPath: string, contextSessionId?: string, ref?: string, line?: number, exp?: string) => {
      const project = projects?.find((p) => p.id === projectId);
      const tab = parseFilePath(
        rawPath,
        project?.repoPath,
        contextSessionId,
        project?.artifactsDir ?? project?.filesDir,
        project?.slug,
      );
      if (!tab) return;
      // A cited experiment pins the file to that node's committed branch, so the
      // tab shows (and labels) the version behind the claim. Agents cite the
      // short id (`orx` prints an 8-char prefix), so match the full id or prefix.
      const experiment = exp
        ? experiments.find((e) => e.id === exp || (exp.length >= 6 && e.id.startsWith(exp)))
        : undefined;
      const effectiveRef = ref ?? experiment?.branchName;
      // A branch ref only applies to repo files; artifacts have no branch.
      if (effectiveRef && tab.source !== "artifacts") tab.ref = effectiveRef;
      if (line != null) tab.line = line;
      // Line is not part of tab identity: reopening a file at a new line reuses
      // the tab but makes the new (line-carrying) def the active one so the
      // viewer re-scrolls.
      setFileTabs((prev) => (prev.some((t) => sameFileTab(t, tab)) ? prev : [...prev, tab]));
      setRightTab(tab);
      setPanelOpen(true);
    },
    [projects, projectId, experiments],
  );

  // Chat file chips carry an optional target line (`file:line`) and cited
  // experiment (`exp`), never a branch ref — adapt to openFileTab's
  // (path, session, ref, line, exp) shape while staying referentially stable
  // for ChatPanel's memoized transcript.
  const openChatFile = useCallback(
    (path: string, sessionId?: string, line?: number, exp?: string) =>
      openFileTab(path, sessionId, undefined, line, exp),
    [openFileTab],
  );

  const closeFileTab = useCallback(
    (tab: FileViewDef) => {
      const idx = fileTabs.findIndex((t) => sameFileTab(t, tab));
      if (idx === -1) return;
      const next = fileTabs.filter((_, i) => i !== idx);
      setFileTabs(next);
      if (typeof rightTab === "object" && "path" in rightTab && sameFileTab(rightTab, tab)) {
        const fallback =
          next[Math.min(idx, next.length - 1)] ??
          (experimentsTabOpen ? "experiments" : undefined) ??
          (filesTabOpen ? "files" : undefined) ??
          expTabs[0] ??
          planTabs[0] ??
          subagentTabs[0] ??
          codeTabs[0];
        if (fallback) setRightTab(fallback);
        else {
          setPanelOpen(false);
          setPanelMax(false);
        }
      }
    },
    [
      fileTabs,
      rightTab,
      experimentsTabOpen,
      filesTabOpen,
      expTabs,
      planTabs,
      subagentTabs,
      codeTabs,
    ],
  );

  // Open a proposed plan as a right-panel tab (the chat plan strip's "View
  // plan"). One tab per plan card; re-opening the same card refreshes its
  // text (a revised plan re-uses the strip but is a new promptId → new tab).
  const openPlanTab = useCallback((plan: string, sessionId: string, promptId: string) => {
    const tab: PlanViewDef = { kind: "plan", sessionId, promptId, plan };
    setPlanTabs((prev) => {
      const idx = prev.findIndex((t) => t.promptId === promptId);
      if (idx === -1) return [...prev, tab];
      const next = prev.slice();
      next[idx] = tab;
      return next;
    });
    setRightTab(tab);
    setPanelOpen(true);
  }, []);

  const closePlanTab = useCallback(
    (tab: PlanViewDef) => {
      const idx = planTabs.findIndex((t) => t.promptId === tab.promptId);
      if (idx === -1) return;
      const next = planTabs.filter((_, i) => i !== idx);
      setPlanTabs(next);
      if (
        typeof rightTab === "object" &&
        "kind" in rightTab &&
        rightTab.kind === "plan" &&
        rightTab.promptId === tab.promptId
      )
        {
          const fallback =
            next[Math.min(idx, next.length - 1)] ??
            (experimentsTabOpen ? "experiments" : undefined) ??
            (filesTabOpen ? "files" : undefined) ??
            expTabs[0] ??
            fileTabs[0] ??
            subagentTabs[0] ??
            codeTabs[0];
          if (fallback) setRightTab(fallback);
          else {
            setPanelOpen(false);
            setPanelMax(false);
          }
        }
    },
    [
      planTabs,
      rightTab,
      experimentsTabOpen,
      filesTabOpen,
      expTabs,
      fileTabs,
      subagentTabs,
      codeTabs,
    ],
  );

  // Open a sub-agent's transcript as a right-panel tab (a chat spawn row's
  // "view"). One tab per spawn part; its parts stream live off the chat message,
  // so the tab body just reads the current part and needs no fetch.
  const openSubagentTab = useCallback((sessionId: string, spawnPartId: string) => {
    const tab: SubagentViewDef = { kind: "subagent", sessionId, spawnPartId };
    setSubagentTabs((prev) =>
      prev.some((t) => t.spawnPartId === spawnPartId) ? prev : [...prev, tab],
    );
    setRightTab(tab);
    setPanelOpen(true);
  }, []);

  const closeSubagentTab = useCallback(
    (tab: SubagentViewDef) => {
      const idx = subagentTabs.findIndex((t) => t.spawnPartId === tab.spawnPartId);
      if (idx === -1) return;
      const next = subagentTabs.filter((_, i) => i !== idx);
      setSubagentTabs(next);
      if (
        typeof rightTab === "object" &&
        "kind" in rightTab &&
        rightTab.kind === "subagent" &&
        rightTab.spawnPartId === tab.spawnPartId
      )
        {
          const fallback =
            next[Math.min(idx, next.length - 1)] ??
            (experimentsTabOpen ? "experiments" : undefined) ??
            (filesTabOpen ? "files" : undefined) ??
            expTabs[0] ??
            fileTabs[0] ??
            planTabs[0] ??
            codeTabs[0];
          if (fallback) setRightTab(fallback);
          else {
            setPanelOpen(false);
            setPanelMax(false);
          }
        }
    },
    [
      subagentTabs,
      rightTab,
      experimentsTabOpen,
      filesTabOpen,
      expTabs,
      fileTabs,
      planTabs,
      codeTabs,
    ],
  );

  // One Git-backed code tab per branch. Reopening the same branch focuses it
  // at the requested subview; another branch gets its own tab.
  const openCodeTabForExperiment = useCallback(
    (experimentId: string, branch: string, view: CodeView = "files") => {
      const opened: CodeTabDef = {
        code: true,
        experimentId,
        branch,
        view,
        toggled: new Set<string>(),
      };
      setCodeTabs((prev) =>
        prev.some((tab) => sameCodeTab(tab, opened))
          ? prev.map((tab) =>
              sameCodeTab(tab, opened) ? { ...tab, experimentId, view } : tab,
            )
          : [...prev, opened],
      );
      setRightTab(opened);
      setPanelOpen(true);
    },
    [],
  );

  const updateCodeTab = useCallback(
    (tab: CodeTabDef, patch: Partial<Omit<CodeTabDef, "code" | "branch">>) => {
      setCodeTabs((prev) =>
        prev.map((item) => (sameCodeTab(item, tab) ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const closeCodeTab = useCallback(
    (tab: CodeTabDef) => {
      const idx = codeTabs.findIndex((item) => sameCodeTab(item, tab));
      if (idx === -1) return;
      const next = codeTabs.filter((_, index) => index !== idx);
      setCodeTabs(next);
      if (
        typeof rightTab === "object" &&
        "code" in rightTab &&
        sameCodeTab(rightTab, tab)
      )
        {
          const fallback =
            next[Math.min(idx, next.length - 1)] ??
            (experimentsTabOpen ? "experiments" : undefined) ??
            (filesTabOpen ? "files" : undefined) ??
            expTabs[0] ??
            fileTabs[0] ??
            planTabs[0] ??
            subagentTabs[0];
          if (fallback) setRightTab(fallback);
          else {
            setPanelOpen(false);
            setPanelMax(false);
          }
        }
    },
    [
      codeTabs,
      rightTab,
      experimentsTabOpen,
      filesTabOpen,
      expTabs,
      fileTabs,
      planTabs,
      subagentTabs,
    ],
  );

  const openWorktreeTab = useCallback(() => {
    setFilesTabOpen(true);
    setRightTab("files");
    setPanelOpen(true);
  }, []);

  const closeHomeTab = useCallback(
    (tab: "experiments" | "files") => {
      if (tab === "experiments") setExperimentsTabOpen(false);
      else setFilesTabOpen(false);
      if (rightTab !== tab) return;
      const fallback =
        (tab !== "experiments" && experimentsTabOpen ? "experiments" : undefined) ??
        (tab !== "files" && filesTabOpen ? "files" : undefined) ??
        expTabs[0] ??
        fileTabs[0] ??
        planTabs[0] ??
        subagentTabs[0] ??
        codeTabs[0];
      if (fallback) setRightTab(fallback);
      else {
        setPanelOpen(false);
        setPanelMax(false);
      }
    },
    [
      rightTab,
      experimentsTabOpen,
      filesTabOpen,
      expTabs,
      fileTabs,
      planTabs,
      subagentTabs,
      codeTabs,
    ],
  );

  // Drag the panel's left edge to resize; width persists across reloads.
  const resizePanel = (e: React.PointerEvent) => {
    e.preventDefault();
    // Capture the pointer so the terminal/diff views under the cursor don't
    // steal the drag, and suppress text selection for its duration.
    e.currentTarget.setPointerCapture(e.pointerId);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const w = Math.round(window.innerWidth - ev.clientX - PANEL_MARGIN);
      const max = panelMaxWidth();
      // Drag past the usable max by the slop threshold → snap to fullscreen.
      // Dragging back below it drops out of fullscreen to the clamped width.
      if (w > max + FULLSCREEN_SNAP_SLOP) {
        setPanelMax(true);
        return;
      }
      setPanelMax(false);
      const clamped = Math.min(Math.max(w, PANEL_MIN_WIDTH), max);
      setPanelWidth(clamped);
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(clamped));
      } catch {
        // best-effort persistence
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = prevUserSelect;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const onProjectCreated = (project: Project, publicationError: string | null) => {
    setProjects((cur) => (cur ? upsert(cur, project) : [project]));
    setProjectId(project.id);
    setHomeOpen(false);
    if (publicationError) {
      setGithubPublicationError({ projectId: project.id, message: publicationError });
      setMainView("git");
    }
  };

  const onProjectDeleted = (id: string) => {
    setProjects((cur) => (cur ? cur.filter((p) => p.id !== id) : cur));
    if (projectId === id) setProjectId(null);
  };

  const expTab =
    typeof rightTab === "object" && "id" in rightTab ? rightTab : null;
  const fileTab = typeof rightTab === "object" && "path" in rightTab ? rightTab : null;
  // PlanViewDef and SubagentViewDef both carry `kind`; discriminate on its value.
  const planTab =
    typeof rightTab === "object" && "kind" in rightTab && rightTab.kind === "plan"
      ? rightTab
      : null;
  const subagentTab =
    typeof rightTab === "object" && "kind" in rightTab && rightTab.kind === "subagent"
      ? rightTab
      : null;
  const requestedCodeTab =
    typeof rightTab === "object" && "code" in rightTab ? rightTab : null;
  const codeTab = requestedCodeTab
    ? (codeTabs.find((tab) => sameCodeTab(tab, requestedCodeTab)) ?? null)
    : null;
  const activeProject = projects?.find((p) => p.id === projectId) ?? null;
  const tabExperiment = expTab ? (experiments.find((e) => e.id === expTab.id) ?? null) : null;
  const codeExperiment = codeTab
    ? (experiments.find((experiment) => experiment.id === codeTab.experimentId) ?? null)
    : null;

  if (projects === null) {
    return (
      <div className="app">
        <div className="empty-state">
          <span className="spinner" />
        </div>
      </div>
    );
  }

  // First boot: the walkthrough installs and opens the embedded demo project.
  if (projects.length === 0) {
    return (
      <div className="app">
        {onboarded ? (
          <ProjectsHome
            projects={projects}
            onOpen={setProjectId}
            onCreated={onProjectCreated}
            onDeleted={onProjectDeleted}
          />
        ) : (
          <Onboarding
            onDone={(project) => {
              clearReadDemoSessions();
              try {
                localStorage.setItem(ONBOARDED_KEY, "1");
                localStorage.removeItem(TOUR_DONE_KEY);
              } catch {
                // private mode etc. — the flow just replays next boot
              }
              setProjects([project]);
              setProjectId(project.id);
              setOnboarded(true);
            }}
          />
        )}
      </div>
    );
  }

  const railHeader = (
    <RailHeader
      projectName={projects.find((p) => p.id === projectId)?.name ?? ""}
      onHome={() => setHomeOpen(true)}
      onNewProject={() => setNewProjectOpen(true)}
      onRepository={() => setMainView("git")}
      onCollapse={() => setRailOpen(false)}
    />
  );

  return (
    <div className="app">
      {homeOpen ? (
        <ProjectsHome
          projects={projects}
          onOpen={(id) => {
            setProjectId(id);
            setHomeOpen(false);
          }}
          onCreated={onProjectCreated}
          onDeleted={onProjectDeleted}
        />
      ) : (
      <div className="app-body">
        {projectId && (
          <ChatPanel
            projectId={projectId}
            projectName={activeProject?.name ?? ""}
            paperId={projects.find((p) => p.id === projectId)?.paperId}
            railHeader={railHeader}
            railOpen={railOpen}
            onShowRail={() => setRailOpen(true)}
            mainView={mainView}
            onSelectMainView={setMainView}
            panelOpen={panelOpen}
            onTogglePanel={() => {
              if (panelOpen) {
                setPanelMax(false);
              } else {
                setExperimentsTabOpen(true);
                setRightTab("experiments");
              }
              setPanelOpen(!panelOpen);
            }}
            onOpenFile={openChatFile}
            onOpenRun={openRunLogs}
            onOpenPlan={openPlanTab}
            onOpenSubagent={openSubagentTab}
            onOpenWorktree={openWorktreeTab}
            onStartTour={startTour}
            onActiveSessionChange={onActiveSessionChange}
          >
            {mainView === "artifacts" ? (
              (() => {
                const project = projects.find((p) => p.id === projectId);
                return project ? (
                  <ArtifactsTab
                    // Remount per project so selection cannot leak and saved
                    // folder preferences reload for the newly active project.
                    key={project.id}
                    project={project}
                    artifacts={artifacts}
                    onChanged={refreshArtifacts}
                    onOpenStorage={() => setMainView("storage")}
                  />
                ) : null;
              })()
            ) : mainView !== "chat" ? (
              <SettingsView
                tab={mainView}
                project={activeProject}
                githubPublicationError={
                  githubPublicationError && githubPublicationError.projectId === activeProject?.id
                    ? githubPublicationError.message
                    : null
                }
                onProjectUpdate={(project) => {
                  setProjects((current) => (current ? upsert(current, project) : [project]));
                  if (project.githubEnabled) setGithubPublicationError(null);
                }}
                onSelectTab={setMainView}
              />
            ) : null}
          </ChatPanel>
        )}
        {mainView === "chat" && panelOpen && (
        <aside
          className={`right-pane floating-panel ${panelMax ? "max" : ""}`}
          style={panelMax ? undefined : { width: panelWidth }}
          data-onboarding="experiments"
        >
          {!panelMax && <div className="panel-resizer" onPointerDown={resizePanel} />}
          <div className="tabs">
            <div className="tab-strip">
              {experimentsTabOpen && (
                <ClosableTab
                  active={rightTab === "experiments"}
                  label="Experiments"
                  icon={<FlaskConical size={12} style={{ flexShrink: 0 }} />}
                  onSelect={() => setRightTab("experiments")}
                  onClose={() => closeHomeTab("experiments")}
                />
              )}
              {filesTabOpen && (
                <ClosableTab
                  active={rightTab === "files"}
                  label="Files"
                  icon={<FolderGit2 size={12} style={{ flexShrink: 0 }} />}
                  onSelect={() => setRightTab("files")}
                  onClose={() => closeHomeTab("files")}
                />
              )}
              {expTabs.map((t) => {
                const exp = experiments.find((e) => e.id === t.id);
                return (
                  <ClosableTab
                    key={`${t.id}:${t.view}`}
                    active={expTab !== null && sameExpTab(expTab, t)}
                    label={exp ? exp.title || exp.slug : "…"}
                    icon={
                      t.view === "overview" ? (
                        <ChartSpline size={12} style={{ flexShrink: 0 }} />
                      ) : (
                        <Terminal size={12} style={{ flexShrink: 0 }} />
                      )
                    }
                    onSelect={() => setRightTab(t)}
                    onClose={() => closeExperimentTab(t)}
                  />
                );
              })}
              {fileTabs.map((t) => (
                <ClosableTab
                  key={`file:${fileTabKey(t)}`}
                  active={fileTab !== null && sameFileTab(fileTab, t)}
                  label={t.path.split("/").pop() || t.path}
                  icon={<FileCode size={12} style={{ flexShrink: 0 }} />}
                  onSelect={() => setRightTab(t)}
                  onClose={() => closeFileTab(t)}
                />
              ))}
              {planTabs.map((t) => (
                <ClosableTab
                  key={`plan:${t.promptId}`}
                  active={planTab !== null && planTab.promptId === t.promptId}
                  label="Plan"
                  icon={<ScrollText size={12} style={{ flexShrink: 0 }} />}
                  onSelect={() => setRightTab(t)}
                  onClose={() => closePlanTab(t)}
                />
              ))}
              {subagentTabs.map((t) => (
                <ClosableTab
                  key={`subagent:${t.spawnPartId}`}
                  active={subagentTab !== null && subagentTab.spawnPartId === t.spawnPartId}
                  label="Sub-agent"
                  icon={<Users size={12} style={{ flexShrink: 0 }} />}
                  onSelect={() => setRightTab(t)}
                  onClose={() => closeSubagentTab(t)}
                />
              ))}
              {codeTabs.map((tab) => {
                const experiment = experiments.find((item) => item.id === tab.experimentId);
                return (
                  <ClosableTab
                    key={`code:${tab.branch}`}
                    active={codeTab !== null && sameCodeTab(codeTab, tab)}
                    label={experiment?.slug ?? tab.branch}
                    icon={<FolderTree size={12} style={{ flexShrink: 0 }} />}
                    onSelect={() => setRightTab(tab)}
                    onClose={() => closeCodeTab(tab)}
                  />
                );
              })}
            </div>
            <div className="panel-controls">
              <button
                className="icon-btn"
                title={panelMax ? "Restore panel" : "Expand panel"}
                aria-label={panelMax ? "Restore panel" : "Expand panel"}
                onClick={() => setPanelMax((m) => !m)}
              >
                {panelMax ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                className="icon-btn"
                title="Close panel"
                aria-label="Close panel"
                onClick={() => {
                  setPanelOpen(false);
                  setPanelMax(false);
                }}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          {rightTab === "experiments" ? (
            <div className="tab-body">
              <div className={`pane-toolbar${view === "table" ? " table-view" : ""}`}>
                <span style={{ flex: 1 }} />
                <div className="experiments-toolbar-controls">
                  <div className="option-picker" ref={scopeMenuRef}>
                    <button
                      ref={scopeTriggerRef}
                      className={`icon-btn experiment-scope-trigger${effectiveScope === "agent" ? " active" : ""}`}
                      title={`Experiment filter: ${effectiveScope === "agent" ? "Current task" : "Entire project"}`}
                      aria-label="Filter experiments"
                      aria-expanded={scopeMenuOpen}
                      onClick={() => setScopeMenuOpen((open) => !open)}
                    >
                      <Filter size={16} strokeWidth={2.5} />
                    </button>
                    {scopeMenuOpen && (
                      <div className="option-menu drop-down align-right experiment-scope-menu">
                        <button
                          className="model-item"
                          aria-pressed={effectiveScope === "agent"}
                          disabled={!activeSessionId || !allExperimentsAttributed}
                          title={
                            !activeSessionId
                              ? "Open a task to filter to its experiments"
                              : !allExperimentsAttributed
                                ? "Current task filtering is unavailable for unattributed experiments"
                                : undefined
                          }
                          onClick={() => {
                            setScope("agent");
                            setScopeMenuOpen(false);
                          }}
                        >
                          <span>Current task</span>
                          {effectiveScope === "agent" && <Check size={13} />}
                        </button>
                        <button
                          className="model-item"
                          aria-pressed={effectiveScope === "project"}
                          onClick={() => {
                            setScope("project");
                            setScopeMenuOpen(false);
                          }}
                        >
                          <span>Entire project</span>
                          {effectiveScope === "project" && <Check size={13} />}
                        </button>
                      </div>
                    )}
                  </div>
                  <div
                    className="seg experiments-view-toggle"
                    role="group"
                    aria-label="Experiment view"
                  >
                    <button
                      className={view === "table" ? "active" : ""}
                      aria-pressed={view === "table"}
                      onClick={() => setView("table")}
                    >
                      Table
                    </button>
                    <button
                      className={view === "tree" ? "active" : ""}
                      aria-pressed={view === "tree"}
                      onClick={() => setView("tree")}
                    >
                      Tree
                    </button>
                  </div>
                </div>
              </div>
              <div className="pane-content">
                {view === "tree" ? (
                  activeProject && (
                    <TreeView
                      experiments={experiments}
                      runs={scopedRuns}
                      project={activeProject}
                      onOpenView={openExperimentTab}
                      onOpenCode={openCodeTabForExperiment}
                      agentSessionId={effectiveScope === "agent" ? activeSessionId : null}
                      onShowProjectScope={showProjectScope}
                    />
                  )
                ) : (
                  <ExperimentsTable
                    runs={scopedRuns}
                    emptyHint={
                      effectiveScope === "agent" && experiments.length > 0
                        ? "No experiments from the current task yet. Switch to Entire project to see all experiments."
                        : undefined
                    }
                    experiments={scopedExperiments}
                    onOpen={(experiment) => {
                      openExperimentTab(experiment.id, "overview");
                    }}
                    onOpenLogs={(experimentId, runId) => {
                      setSelectedRunId(runId);
                      openExperimentTab(experimentId, "terminal");
                    }}
                    onOpenChanges={(experimentId) => {
                      const experiment = experiments.find((item) => item.id === experimentId);
                      if (experiment)
                        openCodeTabForExperiment(
                          experiment.id,
                          experiment.branchName,
                          "changes",
                        );
                    }}
                    onOpenCode={(experimentId) => {
                      const experiment = experiments.find((item) => item.id === experimentId);
                      if (experiment)
                        openCodeTabForExperiment(experiment.id, experiment.branchName, "files");
                    }}
                    onCancel={cancelRun}
                  />
                )}
              </div>
            </div>
          ) : rightTab === "files" ? (
            <div className="tab-body">
              {projectId && activeSessionId ? (
                <WorktreeTab
                  key={`files:${activeSessionId}`}
                  sessionId={activeSessionId}
                  projectId={projectId}
                  view={filesView}
                  toggled={filesToggled}
                  onViewChange={setFilesView}
                  onToggledChange={setFilesToggled}
                  onOpenFile={openFileTab}
                />
              ) : (
                <div className="code-tab wt-tab">
                  <div className="code-tab-body">
                    <div className="wt-empty">
                      <FolderGit2 size={22} />
                      <p>Open a session to browse its current worktree.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : fileTab ? (
            <div className="tab-body">
              {projectId && (
                <FileViewer
                  key={fileTabKey(fileTab)}
                  projectId={projectId}
                  path={fileTab.path}
                  source={fileTab.source}
                  sessionId={fileTab.sessionId}
                  gitRef={fileTab.ref}
                  line={fileTab.line}
                  branchLabel={fileBranchLabel(fileTab, activeProject?.baselineBranch)}
                  onOpenFile={openFileTab}
                />
              )}
            </div>
          ) : planTab ? (
            <div className="tab-body">
              {/* The plan markdown is already client-side — render directly,
                  file links resolve against the plan's session worktree. */}
              <div className="pane-content plan-tab-content">
                <Md
                  text={planTab.plan}
                  onOpenFile={(path) => openFileTab(path, planTab.sessionId)}
                />
              </div>
            </div>
          ) : subagentTab ? (
            <SubagentTab
              // Remount per spawn part so the seed + subscription reset cleanly.
              key={subagentTab.spawnPartId}
              sessionId={subagentTab.sessionId}
              spawnPartId={subagentTab.spawnPartId}
              onOpenFile={(path) => openFileTab(path, subagentTab.sessionId)}
              onOpenSubagent={(pid) => openSubagentTab(subagentTab.sessionId, pid)}
            />
          ) : codeTab ? (
            <div className="tab-body">
              {projectId && activeProject && codeTab && codeExperiment && (
                <CodeTab
                  key={`code:${codeTab.branch}`}
                  projectId={projectId}
                  project={activeProject}
                  experiment={codeExperiment}
                  view={codeTab.view}
                  toggled={codeTab.toggled}
                  onViewChange={(view) => updateCodeTab(codeTab, { view })}
                  onToggledChange={(toggled) => updateCodeTab(codeTab, { toggled })}
                  onOpenFile={openFileTab}
                />
              )}
            </div>
          ) : (
            <div className="tab-body">
              {expTab && tabExperiment && activeProject && (
                <DetailDrawer
                  key={`${expTab.id}:${expTab.view}`}
                  experiment={tabExperiment}
                  project={activeProject}
                  view={expTab.view}
                  runs={runs}
                  selectedRunId={selectedRunId}
                  onSelectRun={setSelectedRunId}
                  parentExperiment={
                    experiments.find(
                      (experiment) => experiment.id === tabExperiment.parentExperimentId,
                    ) ?? null
                  }
                  onOpenView={(view, runId) => {
                    if (runId) setSelectedRunId(runId);
                    openExperimentTab(tabExperiment.id, view);
                  }}
                  onOpenCode={(view) =>
                    openCodeTabForExperiment(
                      tabExperiment.id,
                      tabExperiment.branchName,
                      view,
                    )
                  }
                />
              )}
            </div>
          )}
        </aside>
        )}
      </div>
      )}
      {newProjectOpen && (
        <NewProjectDialog
          onClose={() => setNewProjectOpen(false)}
          onCreated={(project, publicationError) => {
            setNewProjectOpen(false);
            onProjectCreated(project, publicationError);
          }}
        />
      )}
      {tourOpen && !homeOpen && projectId && <Tour onClose={closeTour} />}
    </div>
  );
}
