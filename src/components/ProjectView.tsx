import { useState, useCallback, useMemo } from "react";
import { useAppStore } from "../stores/appStore";
import { createTodo, toggleTodoStatus, closeProject, fetchProjects, createProject } from "../lib/notion";
import { IconBriefcase, IconCheck, IconChevronDown, IconFolder, IconHeart, IconInbox, IconPlus, IconSearch, IconTarget, IconX } from "./Icons";
import type { Todo, Priority, Project } from "../types";

const PRIORITY_COLORS: Record<Priority, string> = {
  High: "priority-high",
  Medium: "priority-medium",
  Low: "priority-low",
};

const PRIORITY_LABELS: Record<Priority, string> = {
  High: "高",
  Medium: "中",
  Low: "低",
};

type PriorityFilter = "all" | Priority;

interface Section {
  id: string;
  name: string;
  icon: "work" | "life" | "project" | "inbox";
  todos: Todo[];
  projects?: ProjectSection[];
}

interface ProjectSection {
  id: string;
  name: string;
  todos: Todo[];
  doneCount: number;
  totalCount: number;
}

export default function ProjectView() {
  const todos = useAppStore((s) => s.todos);
  const projects = useAppStore((s) => s.projects);
  const addTodo = useAppStore((s) => s.addTodo);
  const updateTodo = useAppStore((s) => s.updateTodo);
  const token = useAppStore((s) => s.settings.notionToken);
  const setProjects = useAppStore((s) => s.setProjects);

  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["__other__"]));
  const [showCompleted, setShowCompleted] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>("Medium");
  const [newProjectId, setNewProjectId] = useState("");
  const [newTag, setNewTag] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const archivedIds = useMemo(() => new Set(projects.filter((p) => p.archived).map((p) => p.id)), [projects]);
  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);

  const sections = useMemo((): Section[] => {
    const q = query.trim().toLowerCase();
    const filteredByPriority = priorityFilter === "all" ? todos : todos.filter((t) => t.priority === priorityFilter);
    const filtered = q ? filteredByPriority.filter((t) => t.name.toLowerCase().includes(q)) : filteredByPriority;
    const activeTodos = filtered.filter((t) => !t.projectId || !archivedIds.has(t.projectId));
    const inboxTodos = activeTodos.filter((t) => !t.projectId);
    const projectTodosMap = new Map<string, Todo[]>();
    for (const t of activeTodos) {
      if (t.projectId) {
        if (!projectTodosMap.has(t.projectId)) projectTodosMap.set(t.projectId, []);
        projectTodosMap.get(t.projectId)!.push(t);
      }
    }

    const result: Section[] = [];

    const workTodos = inboxTodos.filter((t) => t.tags.includes("工作"));
    if (workTodos.length > 0) result.push({ id: "__work", name: "工作", icon: "work", todos: workTodos });

    const lifeTodos = inboxTodos.filter((t) => t.tags.includes("生活"));
    if (lifeTodos.length > 0) result.push({ id: "__life", name: "生活", icon: "life", todos: lifeTodos });

    const projectSections: ProjectSection[] = [];
    for (const proj of activeProjects) {
      const projTodos = projectTodosMap.get(proj.id);
      if (projTodos && projTodos.length > 0) {
        projectSections.push({
          id: proj.id, name: proj.name, todos: projTodos,
          doneCount: projTodos.filter((t) => t.status).length,
          totalCount: projTodos.length,
        });
      }
    }
    if (projectSections.length > 0) result.push({ id: "__projects", name: "项目", icon: "project", todos: [], projects: projectSections });

    const otherTodos = inboxTodos.filter((t) => !t.tags.includes("工作") && !t.tags.includes("生活"));
    if (otherTodos.length > 0) result.push({ id: "__other", name: "收件箱", icon: "inbox", todos: otherTodos });

    return result;
  }, [todos, projects, archivedIds, activeProjects, priorityFilter, query]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  const toggleShowCompleted = useCallback((id: string) => {
    setShowCompleted((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  const handleToggle = useCallback(async (id: string, current: boolean) => {
    updateTodo(id, { status: !current });
    try { await toggleTodoStatus(token, id, !current); } catch { updateTodo(id, { status: current }); }
  }, [token, updateTodo]);

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || adding || newProjectId === "__new__") return;
    setAdding(true);
    try {
      const tags = newTag ? [newTag] : undefined;
      const todo = await createTodo(token, newName.trim(), newPriority, newProjectId || undefined, tags);
      addTodo(todo);
      setNewName(""); setNewPriority("Medium"); setNewProjectId(""); setNewTag("");
      setShowAddForm(false);
    } catch (e) { console.error("Add todo failed:", e); }
    finally { setAdding(false); }
  }, [newName, newPriority, newProjectId, newTag, adding, token, addTodo]);

  const handleCloseProject = useCallback(async (id: string) => {
    try {
      await closeProject(token, id);
      const updated = await fetchProjects(token);
      setProjects(updated);
    } catch (e) { console.error("Close project failed:", e); }
  }, [token, setProjects]);

  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim()) return;
    try {
      const proj = await createProject(token, newProjectName.trim());
      setProjects([...projects, proj]);
      setNewProjectId(proj.id);
      setNewProjectName("");
      setShowNewProject(false);
    } catch (e) { console.error("Create project failed:", e); }
  }, [newProjectName, token, projects, setProjects]);

  const FILTER_OPTIONS: { id: PriorityFilter; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "High", label: "高" },
    { id: "Medium", label: "中" },
    { id: "Low", label: "低" },
  ];

  return (
    <div className="space-y-3 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-1 pt-1 pb-1">
        <h1 className="text-display text-text-primary">目标</h1>
        {/* Filter chips */}
        <div className="flex items-center gap-1">
          {FILTER_OPTIONS.map((f) => (
            <button
              key={f.id}
              onClick={() => setPriorityFilter(f.id)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-all ${
                priorityFilter === f.id
                  ? "bg-accent-blue/15 text-accent-blue"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card px-3 py-2 flex items-center gap-2">
        <IconSearch size={13} className="text-text-muted flex-shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索任务"
          className="flex-1 bg-transparent outline-none text-[12px] text-text-primary placeholder:text-text-muted"
        />
        {query && (
          <button onClick={() => setQuery("")} className="text-text-muted hover:text-text-primary transition-colors">
            <IconX size={12} />
          </button>
        )}
      </div>

      {/* Sections */}
      <div className="space-y-2.5">
        {sections.map((section) => {
          const isCollapsed = collapsed.has(section.id);
          const isProjectSection = section.id === "__projects";

          return (
            <div key={section.id} className="card overflow-hidden">
              {/* Section header */}
              {!isProjectSection && (
                <>
                  <button
                    onClick={() => toggleCollapse(section.id)}
                    className="w-full p-3 flex items-center gap-2 hover:bg-bg-hover transition-colors text-left"
                  >
                    <Chevron collapsed={isCollapsed} />
                    <SectionIcon type={section.icon} />
                    <span className="text-[12px] font-semibold text-text-primary flex-1">{section.name}</span>
                    <span className="text-[10px] text-text-muted tabular-nums">{section.todos.length}</span>
                  </button>

                  {!isCollapsed && (
                    <div className="px-3 pb-3 space-y-0.5">
                      {section.todos.filter((t) => !t.status).map((todo) => (
                        <TaskRow key={todo.id} todo={todo} onToggle={handleToggle} />
                      ))}
                      {section.todos.filter((t) => t.status).length > 0 && (
                        <button
                          onClick={() => toggleShowCompleted(section.id)}
                          className="w-full text-[10px] text-text-muted hover:text-text-secondary py-1.5 transition-colors"
                        >
                          {showCompleted.has(section.id) ? "收起已完成" : `已完成(${section.todos.filter((t) => t.status).length})`}
                        </button>
                      )}
                      {showCompleted.has(section.id) &&
                        section.todos.filter((t) => t.status).map((todo) => (
                          <TaskRow key={todo.id} todo={todo} onToggle={handleToggle} />
                        ))
                      }
                    </div>
                  )}
                </>
              )}

              {/* Project sub-sections */}
              {isProjectSection && section.projects && (
                <div className="p-2.5 space-y-1.5">
                  {section.projects.map((proj) => (
                    <ProjectGroup
                      key={proj.id}
                      project={proj}
                      collapsed={collapsed.has(proj.id)}
                      showCompleted={showCompleted.has(proj.id)}
                      onToggleCollapse={toggleCollapse}
                      onToggleShowCompleted={toggleShowCompleted}
                      onToggleTask={handleToggle}
                      onCloseProject={handleCloseProject}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Task */}
      <div className="anim-card">
        {showAddForm ? (
          <div className="card p-3.5">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="任务名称..."
              className="input-field mb-2.5"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") { setShowAddForm(false); setNewName(""); } }}
            />
            <div className="flex gap-2 mb-2.5">
              <select value={newPriority} onChange={(e) => setNewPriority(e.target.value as Priority)} className="input-field flex-1 cursor-pointer">
                <option value="High">高优先级</option>
                <option value="Medium">中优先级</option>
                <option value="Low">低优先级</option>
              </select>
              <select value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)} className="input-field flex-1 cursor-pointer">
                <option value="">无项目</option>
                {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value="__new__">+ 新建项目</option>
              </select>
            </div>

            <div className="grid grid-cols-3 gap-1.5 mb-2.5">
              {["", "工作", "生活"].map((tag) => (
                <button
                  key={tag || "none"}
                  onClick={() => setNewTag(tag)}
                  className={`px-2 py-1.5 rounded-lg text-[10px] transition-colors ${
                    newTag === tag ? "bg-accent-blue/15 text-accent-blue" : "bg-bg-hover text-text-muted hover:text-text-primary"
                  }`}
                >
                  {tag || "无标签"}
                </button>
              ))}
            </div>

            {/* New project inline */}
            {newProjectId === "__new__" && (
              <div className="flex gap-2 mb-2.5">
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="项目名称..."
                  className="input-field flex-1"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateProject(); }}
                />
                <button onClick={handleCreateProject} className="btn-primary text-[10px] px-2.5">创建</button>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button onClick={() => { setShowAddForm(false); setNewName(""); setNewTag(""); setNewProjectId(""); }} className="btn-ghost text-[11px] px-3 py-1.5">取消</button>
              <button onClick={handleAdd} disabled={adding || !newName.trim() || newProjectId === "__new__"} className="btn-primary text-[11px] px-4 py-1.5 disabled:opacity-40">{adding ? "..." : "添加"}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAddForm(true)} className="card w-full p-3 flex items-center justify-center gap-2 hover:bg-bg-card-hover transition-colors text-accent-blue">
            <IconPlus size={14} />
            <span className="text-[12px] font-medium">新增任务</span>
          </button>
        )}
      </div>

      {sections.length === 0 && (
        <div className="card p-5 text-center">
          <div className="mx-auto mb-2 w-9 h-9 rounded-[12px] bg-accent-blue/10 text-accent-blue flex items-center justify-center">
            <IconTarget size={18} />
          </div>
          <h3 className="text-[13px] font-semibold text-text-primary">{query ? "没有匹配任务" : "暂无任务"}</h3>
          <p className="text-body mt-1">{query ? "换个关键词，或清空搜索继续浏览。" : "新增一个任务后，这里会按项目自动归组。"}</p>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ── */

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span className="text-[10px] text-text-muted transition-transform duration-200" style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
      <IconChevronDown size={12} />
    </span>
  );
}

function SectionIcon({ type }: { type: Section["icon"] }) {
  const cls = "text-text-muted flex-shrink-0";
  if (type === "work") return <IconBriefcase size={13} className={cls} />;
  if (type === "life") return <IconHeart size={13} className={cls} />;
  if (type === "project") return <IconFolder size={13} className={cls} />;
  return <IconInbox size={13} className={cls} />;
}

function ProjectGroup({ project, collapsed, showCompleted, onToggleCollapse, onToggleShowCompleted, onToggleTask, onCloseProject }: {
  project: ProjectSection;
  collapsed: boolean;
  showCompleted: boolean;
  onToggleCollapse: (id: string) => void;
  onToggleShowCompleted: (id: string) => void;
  onToggleTask: (id: string, current: boolean) => void;
  onCloseProject: (id: string) => void;
}) {
  const incomplete = project.todos.filter((t) => !t.status);
  const completed = project.todos.filter((t) => t.status);
  const pct = project.totalCount > 0 ? (project.doneCount / project.totalCount) * 100 : 0;

  return (
    <div className="rounded-[12px] overflow-hidden" style={{ background: "var(--bg-hover)" }}>
      <button
        onClick={() => onToggleCollapse(project.id)}
        className="w-full p-2.5 flex items-center gap-2 hover:bg-bg-pressed transition-colors text-left group"
      >
        <Chevron collapsed={collapsed} />
        <span className="text-[12px] font-semibold text-text-primary flex-1 truncate">{project.name}</span>
        <div className="w-14 h-[3px] bg-bg-card rounded-full overflow-hidden flex-shrink-0">
          <div className="h-full bg-accent-green rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[10px] text-text-muted flex-shrink-0 tabular-nums">{project.doneCount}/{project.totalCount}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onCloseProject(project.id); }}
          className="w-5 h-5 flex items-center justify-center text-text-muted hover:text-accent-red transition-colors opacity-0 group-hover:opacity-100"
          title="关闭项目"
        >
          <IconX size={11} />
        </button>
      </button>

      {!collapsed && (
        <div className="px-2.5 pb-2.5 space-y-0.5">
          {incomplete.map((todo) => (
            <TaskRow key={todo.id} todo={todo} onToggle={onToggleTask} />
          ))}
          {completed.length > 0 && (
            <button
              onClick={() => onToggleShowCompleted(project.id)}
              className="w-full text-[10px] text-text-muted hover:text-text-secondary py-1.5 transition-colors"
            >
              {showCompleted ? "收起已完成" : `已完成(${completed.length})`}
            </button>
          )}
          {showCompleted && completed.map((todo) => (
            <TaskRow key={todo.id} todo={todo} onToggle={onToggleTask} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ todo, onToggle }: { todo: Todo; onToggle: (id: string, current: boolean) => void }) {
  return (
    <div className="flex items-center gap-2 py-1.5 group task-row">
      <button
        onClick={() => onToggle(todo.id, todo.status)}
        className={`w-[15px] h-[15px] rounded-[5px] border flex-shrink-0 flex items-center justify-center task-check ${
          todo.status ? "bg-accent-green border-accent-green task-check-done" : "border-text-muted/40 hover:border-accent-blue"
        }`}
      >
        {todo.status && <IconCheck size={10} className="text-white" />}
      </button>
      <span className={`flex-1 text-[12px] truncate ${todo.status ? "line-through text-text-muted" : "text-text-primary font-medium"}`}>
        {todo.name}
      </span>
      <span className={`priority-badge ${PRIORITY_COLORS[todo.priority]}`}>
        {PRIORITY_LABELS[todo.priority]}
      </span>
    </div>
  );
}
