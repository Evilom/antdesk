import { useState, useCallback, useMemo } from "react";
import { useAppStore } from "../stores/appStore";
import { createTodo, toggleTodoStatus, closeProject, fetchProjects } from "../lib/notion";
import type { Todo, Priority, Project } from "../types";

const PRIORITY_COLORS: Record<Priority, string> = {
  High: "bg-accent-red/20 text-accent-red",
  Medium: "bg-accent-yellow/20 text-accent-yellow",
  Low: "bg-accent-green/20 text-accent-green",
};

const PRIORITY_LABELS: Record<Priority, string> = {
  High: "高",
  Medium: "中",
  Low: "低",
};

const TAG_ICONS: Record<string, string> = {
  工作: " ",
  生活: " ",
};

type PriorityFilter = "all" | Priority;

interface Section {
  id: string;
  name: string;
  icon?: string;
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["__other__"]));
  const [showCompleted, setShowCompleted] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>("Medium");
  const [newProjectId, setNewProjectId] = useState("");
  const [newTag, setNewTag] = useState<string>("");
  const [adding, setAdding] = useState(false);

  // Archived project IDs
  const archivedIds = useMemo(
    () => new Set(projects.filter((p) => p.archived).map((p) => p.id)),
    [projects]
  );
  const activeProjects = useMemo(
    () => projects.filter((p) => !p.archived),
    [projects]
  );

  const sections = useMemo((): Section[] => {
    const filtered =
      priorityFilter === "all"
        ? todos
        : todos.filter((t) => t.priority === priorityFilter);

    // Filter out todos from archived projects
    const activeTodos = filtered.filter(
      (t) => !t.projectId || !archivedIds.has(t.projectId)
    );

    // Split: inbox (no project) vs project tasks
    const inboxTodos = activeTodos.filter((t) => !t.projectId);
    const projectTodosMap = new Map<string, Todo[]>();
    for (const t of activeTodos) {
      if (t.projectId) {
        if (!projectTodosMap.has(t.projectId)) projectTodosMap.set(t.projectId, []);
        projectTodosMap.get(t.projectId)!.push(t);
      }
    }

    const result: Section[] = [];

    // 工作 section
    const workTodos = inboxTodos.filter((t) => t.tags.includes("工作"));
    if (workTodos.length > 0) {
      result.push({ id: "__work", name: "工作", icon: " ", todos: workTodos });
    }

    // 生活 section
    const lifeTodos = inboxTodos.filter((t) => t.tags.includes("生活"));
    if (lifeTodos.length > 0) {
      result.push({ id: "__life", name: "生活", icon: " ", todos: lifeTodos });
    }

    // 项目 section — contains individual projects
    const projectSections: ProjectSection[] = [];
    for (const proj of activeProjects) {
      const projTodos = projectTodosMap.get(proj.id);
      if (projTodos && projTodos.length > 0) {
        projectSections.push({
          id: proj.id,
          name: proj.name,
          todos: projTodos,
          doneCount: projTodos.filter((t) => t.status).length,
          totalCount: projTodos.length,
        });
      }
    }
    // Always show 项目 section (even if empty, so user can see projects)
    if (projectSections.length > 0) {
      result.push({
        id: "__projects",
        name: "项目",
        icon: " ",
        todos: [],
        projects: projectSections,
      });
    }

    // 其他 — inbox tasks with no matching category
    const otherTodos = inboxTodos.filter(
      (t) => !t.tags.includes("工作") && !t.tags.includes("生活")
    );
    if (otherTodos.length > 0) {
      result.push({ id: "__other", name: "其他", todos: otherTodos });
    }

    return result;
  }, [todos, projects, archivedIds, activeProjects, priorityFilter]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleShowCompleted = useCallback((id: string) => {
    setShowCompleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggle = useCallback(
    async (id: string, current: boolean) => {
      if (!token) return;
      updateTodo(id, { status: !current });
      try {
        await toggleTodoStatus(token, id, !current);
      } catch (e) {
        updateTodo(id, { status: current });
        console.error("Failed to toggle todo:", e);
      }
    },
    [token, updateTodo]
  );

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || !token) return;
    setAdding(true);
    try {
      const tags = newTag ? [newTag] : [];
      const todo = await createTodo(
        token,
        newName.trim(),
        newPriority,
        newProjectId || undefined,
        tags
      );
      addTodo(todo);
      setNewName("");
      setNewTag("");
      setNewProjectId("");
      setShowAddForm(false);
    } catch (e) {
      console.error("Failed to create todo:", e);
    } finally {
      setAdding(false);
    }
  }, [newName, newPriority, newProjectId, newTag, token, addTodo]);

  const handleCloseProject = useCallback(
    async (projectId: string) => {
      if (!token || projectId.startsWith("__")) return;
      if (!confirm("确定关闭此项目？项目将在 Notion 中归档。")) return;
      try {
        await closeProject(token, projectId);
        const fresh = await fetchProjects(token);
        setProjects(fresh);
      } catch (e) {
        console.error("Failed to close project:", e);
      }
    },
    [token, setProjects]
  );

  return (
    <div className="space-y-3 fade-in">
      {/* Top Bar */}
      <div className="bg-bg-card rounded-card p-3 flex items-center justify-between">
        <h1 className="text-sm font-semibold text-text-primary">项目</h1>
        <div className="flex items-center gap-2">
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
            className="bg-bg-input text-text-primary text-xs rounded-button px-2 py-1 outline-none border border-white/5 cursor-pointer"
          >
            <option value="all">全部优先级</option>
            <option value="High">高</option>
            <option value="Medium">中</option>
            <option value="Low">低</option>
          </select>
        </div>
      </div>

      {/* Sections */}
      {sections.length === 0 && (
        <div className="text-center text-text-muted text-xs py-8">
          暂无任务
        </div>
      )}

      {sections.map((section, sectionIndex) => {
        const isCollapsed = collapsed.has(section.id);

        // 项目 section — has nested project groups
        if (section.projects) {
          return (
            <div key={section.id} className="bg-bg-card rounded-card overflow-hidden anim-card" style={{ animationDelay: `${sectionIndex * 0.06}s` }}>
              <button
                onClick={() => toggleCollapse(section.id)}
                className="w-full p-3 flex items-center gap-2 hover:bg-bg-hover transition-colors text-left"
              >
                <Chevron collapsed={isCollapsed} />
                <span className="text-sm">{section.icon}</span>
                <span className="text-xs font-semibold text-text-primary flex-1">
                  {section.name}
                </span>
                <span className="text-[10px] text-text-muted">
                  {section.projects.length} 个项目
                </span>
              </button>

              {!isCollapsed && (
                <div className="px-2 pb-2 space-y-1">
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
        }

        // Flat section (工作/生活/其他)
        const incomplete = section.todos.filter((t) => !t.status);
        const completed = section.todos.filter((t) => t.status);
        const isShowCompleted = showCompleted.has(section.id);

        return (
          <div key={section.id} className="bg-bg-card rounded-card overflow-hidden anim-card" style={{ animationDelay: `${sectionIndex * 0.06}s` }}>
            <button
              onClick={() => toggleCollapse(section.id)}
              className="w-full p-3 flex items-center gap-2 hover:bg-bg-hover transition-colors text-left"
            >
              <Chevron collapsed={isCollapsed} />
              {section.icon && <span className="text-sm">{section.icon}</span>}
              <span className="text-xs font-semibold text-text-primary flex-1">
                {section.name}
              </span>
              <span className="text-[10px] text-text-muted">
                {incomplete.length} 项
              </span>
            </button>

            {!isCollapsed && (
              <div className="px-3 pb-3 space-y-1">
                {incomplete.map((todo) => (
                  <TaskRow key={todo.id} todo={todo} onToggle={handleToggle} />
                ))}
                {completed.length > 0 && (
                  <button
                    onClick={() => toggleShowCompleted(section.id)}
                    className="w-full text-[10px] text-text-muted hover:text-text-secondary py-1 transition-colors"
                  >
                    {isShowCompleted ? "收起已完成" : `已完成(${completed.length})`}
                  </button>
                )}
                {isShowCompleted &&
                  completed.map((todo) => (
                    <TaskRow key={todo.id} todo={todo} onToggle={handleToggle} />
                  ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Add Task */}
      {showAddForm ? (
        <div className="bg-bg-card rounded-card p-3 space-y-2 anim-card" style={{ animationDelay: "0s" }}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="任务名称..."
            autoFocus
            className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-blue/50 transition-colors placeholder:text-text-muted"
          />
          {/* Tag selector */}
          <div className="flex gap-1.5">
            {["工作", "生活", "项目"].map((tag) => (
              <button
                key={tag}
                onClick={() => setNewTag(newTag === tag ? "" : tag)}
                className={`px-2.5 py-1 rounded-lg text-[10px] transition-all ${
                  newTag === tag
                    ? tag === "工作"
                      ? "bg-accent-blue/20 text-accent-blue border border-accent-blue/40"
                      : tag === "生活"
                        ? "bg-accent-green/20 text-accent-green border border-accent-green/40"
                        : "bg-accent-orange/20 text-accent-orange border border-accent-orange/40"
                    : "bg-white/5 text-text-muted border border-white/5 hover:bg-white/10"
                }`}
              >
                {tag === "工作" ? " " : tag === "生活" ? " " : " "} {tag}
              </button>
            ))}
          </div>
          {/* Project selector — only show when tag is 项目 or no tag */}
          {(newTag === "项目" || newTag === "") && (
            <select
              value={newProjectId}
              onChange={(e) => setNewProjectId(e.target.value)}
              className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2 py-1.5 outline-none border border-white/5 cursor-pointer"
            >
              <option value="">不关联项目</option>
              {activeProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          {/* Priority + buttons */}
          <div className="flex gap-2 items-center justify-between">
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as Priority)}
              className="bg-bg-input text-text-primary text-xs rounded-button px-2 py-1.5 outline-none border border-white/5 cursor-pointer"
            >
              <option value="High">高优先</option>
              <option value="Medium">中优先</option>
              <option value="Low">低优先</option>
            </select>
            <div className="flex gap-2">
              <button
                onClick={() => { setShowAddForm(false); setNewName(""); setNewTag(""); setNewProjectId(""); }}
                className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleAdd}
                disabled={adding || !newName.trim()}
                className="px-3 py-1.5 bg-accent-blue text-white text-xs rounded-button disabled:opacity-40 hover:bg-accent-blue/80 transition-colors"
              >
                {adding ? "..." : "添加"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full bg-bg-card rounded-card p-3 flex items-center justify-center gap-1.5 hover:bg-bg-hover transition-colors text-accent-blue"
        >
          <span className="text-sm">➕</span>
          <span className="text-xs">新增任务</span>
        </button>
      )}
    </div>
  );
}

/* ---------- Sub-components ---------- */

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span
      className="text-[10px] text-text-muted transition-transform"
      style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
    >
      &#9662;
    </span>
  );
}

function ProjectGroup({
  project,
  collapsed,
  showCompleted,
  onToggleCollapse,
  onToggleShowCompleted,
  onToggleTask,
  onCloseProject,
}: {
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
    <div className="bg-bg-hover/30 rounded-card overflow-hidden">
      <button
        onClick={() => onToggleCollapse(project.id)}
        className="w-full p-2.5 flex items-center gap-2 hover:bg-bg-hover transition-colors text-left group"
      >
        <Chevron collapsed={collapsed} />
        <span className="text-xs font-medium text-text-primary flex-1 truncate">
          {project.name}
        </span>
        <div className="w-14 h-1.5 bg-bg-hover rounded-full overflow-hidden flex-shrink-0">
          <div
            className="h-full bg-accent-green rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {project.doneCount}/{project.totalCount}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCloseProject(project.id);
          }}
          className="w-5 h-5 flex items-center justify-center text-text-muted hover:text-accent-red transition-colors opacity-0 group-hover:opacity-100"
          title="关闭项目"
        >
          <span className="text-[10px]">&#10005;</span>
        </button>
      </button>

      {!collapsed && (
        <div className="px-2.5 pb-2.5 space-y-1">
          {incomplete.map((todo) => (
            <TaskRow key={todo.id} todo={todo} onToggle={onToggleTask} />
          ))}
          {completed.length > 0 && (
            <button
              onClick={() => onToggleShowCompleted(project.id)}
              className="w-full text-[10px] text-text-muted hover:text-text-secondary py-1 transition-colors"
            >
              {showCompleted ? "收起已完成" : `已完成(${completed.length})`}
            </button>
          )}
          {showCompleted &&
            completed.map((todo) => (
              <TaskRow key={todo.id} todo={todo} onToggle={onToggleTask} />
            ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  todo,
  onToggle,
}: {
  todo: Todo;
  onToggle: (id: string, current: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1 group task-row">
      <button
        onClick={() => onToggle(todo.id, todo.status)}
        className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center task-check ${
          todo.status
            ? "bg-accent-green border-accent-green task-check-done"
            : "border-text-muted hover:border-accent-blue"
        }`}
      >
        {todo.status && <span className="text-[10px] text-white">&#10003;</span>}
      </button>
      <span
        className={`flex-1 text-xs truncate ${
          todo.status ? "line-through text-text-muted" : "text-text-primary"
        }`}
      >
        {todo.name}
      </span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded ${PRIORITY_COLORS[todo.priority]}`}>
        {PRIORITY_LABELS[todo.priority]}
      </span>
    </div>
  );
}
