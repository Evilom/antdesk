import { useAppStore } from "../stores/appStore";
import type { Todo } from "../types";

interface Props {
  onRefresh: () => void;
}

export default function Dashboard({ onRefresh }: Props) {
  const todos = useAppStore((s) => s.todos);
  const reports = useAppStore((s) => s.reports);
  const notionConnected = useAppStore((s) => s.notionConnected);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);

  const urgent = todos.filter((t) => t.priority === "High" && !t.status);
  const pending = todos.filter((t) => !t.status);
  const done = todos.filter((t) => t.status);

  return (
    <div className="space-y-3 fade-in">
      {/* Connection Status */}
      <div className="bg-bg-card rounded-card p-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              notionConnected ? "bg-accent-green" : "bg-accent-red"
            }`}
          />
          <span className="text-sm text-text-secondary">
            {notionConnected ? "Notion 已连接" : "Notion 未连接"}
          </span>
        </div>
        <button
          onClick={onRefresh}
          className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors"
        >
          刷新
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="紧急" value={urgent.length} color="text-accent-red" />
        <StatCard
          label="待办"
          value={pending.length}
          color="text-accent-yellow"
        />
        <StatCard
          label="已完成"
          value={done.length}
          color="text-accent-green"
        />
      </div>

      {/* Urgent Tasks */}
      {urgent.length > 0 && (
        <div className="bg-bg-card rounded-card p-3">
          <h3 className="text-xs font-medium text-text-secondary mb-2">
            紧急待办
          </h3>
          <div className="space-y-1.5">
            {urgent.slice(0, 5).map((todo) => (
              <UrgentTask key={todo.id} todo={todo} />
            ))}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-2">
        <QuickAction
          label="新建任务"
          icon="+"
          onClick={() => setCurrentPage("projects")}
        />
        <QuickAction
          label="写日报"
          icon=" "
          onClick={() => setCurrentPage("reports")}
        />
      </div>

      {/* Recent Reports */}
      {reports.length > 0 && (
        <div className="bg-bg-card rounded-card p-3">
          <h3 className="text-xs font-medium text-text-secondary mb-2">
            最近日报
          </h3>
          <div className="space-y-1.5">
            {reports.slice(0, 3).map((report) => (
              <div
                key={report.id}
                className="flex items-center gap-2 text-xs cursor-pointer hover:text-accent-blue transition-colors"
                onClick={() => setCurrentPage("reports")}
              >
                <span className="text-text-muted">{report.date}</span>
                <span className="text-text-secondary truncate">
                  {report.summary || "无摘要"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-bg-card rounded-card p-3 text-center">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

function UrgentTask({ todo }: { todo: Todo }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-1.5 h-1.5 rounded-full bg-accent-red flex-shrink-0" />
      <span className="text-text-primary truncate">{todo.name}</span>
    </div>
  );
}

function QuickAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-bg-card rounded-card p-3 flex items-center gap-2 hover:bg-bg-hover transition-colors"
    >
      <span className="text-lg">{icon}</span>
      <span className="text-xs text-text-secondary">{label}</span>
    </button>
  );
}
