import {
  Activity, AlertTriangle, Bot, BrainCircuit, Check, ChevronRight, CircleDot, Clock3,
  GitBranch, Inbox, KanbanSquare, LayoutDashboard, ListChecks, LoaderCircle, MoreHorizontal,
  Pause, Play, Plus, RefreshCw, RotateCcw, Settings2, ShieldAlert, Sparkles, Square,
  SquareArrowOutUpRight, Trash2, Users, Workflow, XCircle, Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  AgentProject, AgentRole, AgentRun, AppSnapshot, ProjectDraftInput, ReasoningEffort,
  TeamTask, TeamWait, WorkflowCategory, WorkflowState,
} from '../shared/types';
import { runSummary } from '../shared/domain';
import { confirmAction, listen, openSession, post, toast } from './bridge';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog,
  DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input,
  Label, Select, Textarea, cn,
} from './components/ui';

type Tab = 'board' | 'team' | 'runs' | 'inbox' | 'activity';
const reasoningLevels: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const workflowCategories: WorkflowCategory[] = ['backlog', 'ready', 'active', 'review', 'blocked', 'done', 'cancelled'];
const emptySnapshot: AppSnapshot = { schemaVersion: 1, sessionCursors: {}, projects: [], tasks: [], runs: [], waits: [], activities: [], models: [], spaces: [] };

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [tab, setTab] = useState<Tab>('board');
  const [createOpen, setCreateOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState<TeamTask>();
  const [addTaskOpen, setAddTaskOpen] = useState(false);

  useEffect(() => {
    const dispose = listen((message) => {
      if (message.type === 'agent-team:snapshot') {
        setSnapshot(message.snapshot);
        setSelectedProjectId((current) => current && message.snapshot.projects.some((p) => p.id === current)
          ? current : message.snapshot.projects[0]?.id);
      } else if (message.type === 'agent-team:error') void toast(message.message, 'error');
      else if (message.type === 'agent-team:notice') void toast(message.message, message.variant);
    });
    post({ type: 'agent-team:init' });
    return dispose;
  }, []);

  const project = snapshot.projects.find((item) => item.id === selectedProjectId);
  const tasks = useMemo(() => snapshot.tasks.filter((item) => item.projectId === project?.id), [snapshot.tasks, project?.id]);
  const runs = useMemo(() => snapshot.runs.filter((item) => item.projectId === project?.id), [snapshot.runs, project?.id]);
  const waits = useMemo(() => snapshot.waits.filter((item) => item.projectId === project?.id), [snapshot.waits, project?.id]);
  const activities = useMemo(() => snapshot.activities.filter((item) => item.projectId === project?.id).reverse(), [snapshot.activities, project?.id]);

  return <div className="app-shell">
    <ProjectSidebar
      projects={snapshot.projects}
      tasks={snapshot.tasks}
      selectedId={project?.id}
      onSelect={setSelectedProjectId}
      onCreate={() => setCreateOpen(true)}
    />
    <main className="min-w-0 flex-1 overflow-hidden">
      <TopBar snapshot={snapshot} onRefresh={() => post({ type: 'agent-team:refresh' })} />
      {!project ? <EmptyState onCreate={() => setCreateOpen(true)} /> : <>
        <ProjectHeader project={project} tasks={tasks} runs={runs} waits={waits} onWorkflow={() => setWorkflowOpen(true)} />
        <ProjectTabs tab={tab} setTab={setTab} waits={waits.length} runs={runs.length} />
        <section className="project-content">
          {tab === 'board' && <Board project={project} tasks={tasks} runs={runs} onTask={setTaskOpen} onAddTask={() => setAddTaskOpen(true)} />}
          {tab === 'team' && <TeamView project={project} tasks={tasks} runs={runs} snapshot={snapshot} />}
          {tab === 'runs' && <RunsView project={project} runs={runs} tasks={tasks} />}
          {tab === 'inbox' && <InboxView waits={waits} tasks={tasks} />}
          {tab === 'activity' && <ActivityView activities={activities} tasks={tasks} />}
        </section>
      </>}
    </main>
    <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} snapshot={snapshot} />
    {project && <WorkflowDialog open={workflowOpen} onOpenChange={setWorkflowOpen} project={project} />}
    {project && <AddTaskDialog open={addTaskOpen} onOpenChange={setAddTaskOpen} project={project} />}
    {taskOpen && project && <TaskDialog task={snapshot.tasks.find((item) => item.id === taskOpen.id) ?? taskOpen} project={project} runs={runs.filter((run) => run.taskId === taskOpen.id)} open onOpenChange={(open) => !open && setTaskOpen(undefined)} />}
  </div>;
}

function ProjectSidebar({ projects, tasks, selectedId, onSelect, onCreate }: {
  projects: AgentProject[]; tasks: TeamTask[]; selectedId?: string; onSelect: (id: string) => void; onCreate: () => void;
}) {
  return <aside className="project-sidebar">
    <div className="flex h-14 items-center gap-2 border-b border-border px-4">
      <div className="brand-mark"><BrainCircuit className="size-4" /></div>
      <div><div className="text-sm font-semibold">Agent Team</div><div className="text-[11px] text-muted-foreground">Multi-model workspace</div></div>
    </div>
    <div className="flex items-center justify-between px-3 pb-2 pt-4">
      <span className="sidebar-label">项目</span>
      <Button variant="ghost" size="icon" className="size-7" onClick={onCreate} title="创建项目"><Plus className="size-4" /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto px-2">
      {projects.map((project) => {
        const projectTasks = tasks.filter((task) => task.projectId === project.id);
        const done = projectTasks.filter((task) => project.workflow.find((state) => state.id === task.workflowStateId)?.category === 'done').length;
        const progress = projectTasks.length ? Math.round(done / projectTasks.length * 100) : 0;
        return <button key={project.id} className={cn('project-row', selectedId === project.id && 'active')} onClick={() => onSelect(project.id)}>
          <span className="project-dot" data-status={project.status} />
          <span className="min-w-0 flex-1 text-left"><span className="block truncate text-sm font-medium">{project.name}</span><span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground"><span>{done}/{projectTasks.length}</span><span className="progress-track"><span style={{ width: `${progress}%` }} /></span></span></span>
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>;
      })}
      {!projects.length && <div className="px-3 py-8 text-center text-xs text-muted-foreground">还没有项目</div>}
    </div>
    <div className="border-t border-border p-3"><Button className="w-full" size="sm" onClick={onCreate}><Sparkles className="size-4" />AI 创建项目</Button></div>
  </aside>;
}

function TopBar({ snapshot, onRefresh }: { snapshot: AppSnapshot; onRefresh: () => void }) {
  const counts = runSummary(snapshot.runs);
  return <header className="topbar">
    <div className="flex items-center gap-2 text-sm text-muted-foreground"><LayoutDashboard className="size-4" /><span>Agent Team 自有运行</span></div>
    <div className="flex items-center gap-3">
      <span className="runtime-pill" title="仅统计 Agent Team 创建的 Session，不含其他对话"><span className={cn('status-light', counts.active > 0 && 'running', counts.waiting > 0 && 'waiting')} />{counts.active} 运行 · {counts.waiting} 等待</span>
      <Button variant="ghost" size="icon" onClick={onRefresh} title="刷新"><RefreshCw className="size-4" /></Button>
    </div>
  </header>;
}

function ProjectHeader({ project, tasks, runs, waits, onWorkflow }: { project: AgentProject; tasks: TeamTask[]; runs: AgentRun[]; waits: TeamWait[]; onWorkflow: () => void }) {
  const done = tasks.filter((task) => project.workflow.find((state) => state.id === task.workflowStateId)?.category === 'done').length;
  return <div className="project-header">
    <div className="min-w-0"><div className="mb-1 flex items-center gap-2"><h1 className="truncate text-xl font-semibold">{project.name}</h1><StatusBadge status={project.status} /></div><p className="line-clamp-2 max-w-3xl text-sm text-muted-foreground">{project.goal || project.brief}</p></div>
    <div className="flex shrink-0 items-center gap-2">
      {project.commanderSessionId && <Button variant="outline" size="sm" onClick={() => openSession(project.commanderSessionId!)}><SquareArrowOutUpRight className="size-4" />指挥 Session</Button>}
      <Button variant="outline" size="sm" onClick={onWorkflow}><Workflow className="size-4" />Workflow</Button>
      {project.status === 'draft' && <Button size="sm" onClick={() => post({ type: 'agent-team:start-project', projectId: project.id })}><Play className="size-4" />启动 Team</Button>}
      {project.status === 'active' && <Button variant="secondary" size="sm" onClick={() => post({ type: 'agent-team:pause-project', projectId: project.id })}><Pause className="size-4" />暂停</Button>}
      {project.status === 'paused' && <Button size="sm" onClick={() => post({ type: 'agent-team:start-project', projectId: project.id })}><Play className="size-4" />继续</Button>}
      <Button variant="ghost" size="icon" title="删除项目" onClick={async () => {
        if (await confirmAction('删除项目？', `将删除「${project.name}」的看板和运行记录，此操作不可撤销。`)) post({ type: 'agent-team:delete-project', projectId: project.id });
      }}><Trash2 className="size-4" /></Button>
    </div>
    <div className="metrics-row">
      <Metric icon={ListChecks} label="任务" value={`${done}/${tasks.length}`} />
      <Metric icon={Users} label="角色" value={project.roles.length} />
      <Metric icon={Clock3} label="运行记录" value={runs.length} />
      <Metric icon={Zap} label="并行上限" value={project.maxConcurrency} />
      <Metric icon={ShieldAlert} label="等待处理" value={waits.length} danger={waits.length > 0} />
    </div>
  </div>;
}

function Metric({ icon: Icon, label, value, danger }: { icon: typeof Users; label: string; value: string | number; danger?: boolean }) {
  return <div className={cn('metric', danger && 'danger')}><Icon className="size-4" /><span>{label}</span><strong>{value}</strong></div>;
}

function ProjectTabs({ tab, setTab, waits, runs }: { tab: Tab; setTab: (tab: Tab) => void; waits: number; runs: number }) {
  const items: Array<[Tab, string, typeof KanbanSquare]> = [['board', '看板', KanbanSquare], ['team', 'Team', Users], ['runs', '运行记录', Clock3], ['inbox', '授权中心', Inbox], ['activity', '活动', Activity]];
  return <nav className="project-tabs">{items.map(([id, label, Icon]) => <button key={id} className={cn('tab-button', tab === id && 'active')} onClick={() => setTab(id)}><Icon className="size-4" />{label}{id === 'runs' && runs > 0 && <span className="count-badge neutral">{runs}</span>}{id === 'inbox' && waits > 0 && <span className="count-badge">{waits}</span>}</button>)}</nav>;
}

function StatusBadge({ status }: { status: AgentProject['status'] }) {
  const map = { planning: ['规划中', 'warning'], draft: ['草案', 'secondary'], active: ['执行中', 'default'], paused: ['已暂停', 'outline'], completed: ['已完成', 'positive'], failed: ['失败', 'danger'] } as const;
  return <Badge variant={map[status][1]}>{status === 'planning' && <LoaderCircle className="mr-1 size-3 animate-spin" />}{map[status][0]}</Badge>;
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-state"><div className="empty-orbit"><Bot className="size-8" /></div><h2>组建你的 Agent Team</h2><p>描述项目目标，让指挥模型生成角色、Workflow、依赖与可验证任务。</p><Button onClick={onCreate}><Sparkles className="size-4" />AI 创建第一个项目</Button></div>;
}

function Board({ project, tasks, runs, onTask, onAddTask }: { project: AgentProject; tasks: TeamTask[]; runs: AgentRun[]; onTask: (task: TeamTask) => void; onAddTask: () => void }) {
  return <div className="board-wrap">
    <div className="mb-3 flex items-center justify-between"><div className="text-xs text-muted-foreground">拖动卡片流转状态；运行状态由 Turn 事件实时同步。</div><Button variant="outline" size="sm" onClick={onAddTask}><Plus className="size-4" />任务</Button></div>
    <div className="kanban-grid">{[...project.workflow].sort((a, b) => a.order - b.order).map((state) => {
      const columnTasks = tasks.filter((task) => task.workflowStateId === state.id);
      return <section className="kanban-column" key={state.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
        const taskId = event.dataTransfer.getData('text/agent-team-task');
        if (taskId) post({ type: 'agent-team:move-task', taskId, workflowStateId: state.id });
      }}>
        <header className="column-header"><span className="column-color" style={{ background: state.color }} /><span className="font-medium">{state.name}</span><span className="ml-auto text-xs text-muted-foreground">{columnTasks.length}</span></header>
        <div className="column-body">{columnTasks.map((task) => <TaskCard key={task.id} task={task} role={project.roles.find((role) => role.id === task.roleId)} run={runs.find((run) => run.id === task.activeRunId)} onClick={() => onTask(task)} />)}{columnTasks.length === 0 && <div className="column-empty"><Square className="size-4" />暂无任务</div>}</div>
      </section>;
    })}</div>
  </div>;
}

function TaskCard({ task, role, run, onClick }: { task: TeamTask; role?: AgentRole; run?: AgentRun; onClick: () => void }) {
  return <article className="task-card" draggable onDragStart={(event) => event.dataTransfer.setData('text/agent-team-task', task.id)} onClick={onClick}>
    <div className="mb-2 flex items-start justify-between gap-2"><h3 className="line-clamp-2 text-sm font-medium leading-snug">{task.title}</h3><MoreHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" /></div>
    {task.description && <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{task.description}</p>}
    {run && <div className={cn('run-strip', run.state === 'waiting' && 'waiting', run.state === 'failed' && 'failed')}><LoaderCircle className={cn('size-3.5', ['queued', 'running'].includes(run.state) && 'animate-spin')} /><span>{run.state === 'queued' ? `排队 #${(run.queuePosition ?? 0) + 1}` : run.state === 'waiting' ? '等待用户' : run.state === 'running' ? '执行中' : run.state}</span></div>}
    {run?.streamText && <div className="stream-preview">{run.streamText.slice(-180)}</div>}
    <footer className="mt-3 flex items-center gap-2 border-t border-border/70 pt-2.5"><span className="avatar" style={{ background: role?.color ?? 'var(--accent)' }}>{role?.name.slice(0, 1) ?? '?'}</span><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{role?.name ?? '未分配'}</span>{task.dependencyIds.length > 0 && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><GitBranch className="size-3" />{task.dependencyIds.length}</span>}<span className="priority">P{task.priority}</span></footer>
  </article>;
}

function TeamView({ project, tasks, runs, snapshot }: { project: AgentProject; tasks: TeamTask[]; runs: AgentRun[]; snapshot: AppSnapshot }) {
  const [editingRole, setEditingRole] = useState<AgentRole>();
  return <>
    <div className="content-grid">{project.roles.map((role) => {
      const roleTasks = tasks.filter((task) => task.roleId === role.id);
      const active = roleTasks.filter((task) => task.activeRunId).length;
      const done = roleTasks.filter((task) => project.workflow.find((state) => state.id === task.workflowStateId)?.category === 'done').length;
      const model = snapshot.models.find((item) => item.modelKey === role.modelKey);
      const space = snapshot.spaces.find((item) => item.id === role.spaceId);
      const location = space?.name ?? (role.useWorkspace ? '默认工作间' : '未设置工作地点');
      return <Card key={role.id} className="role-card"><CardHeader><div className="flex items-start justify-between"><span className="role-avatar" style={{ background: role.color }}>{role.name.slice(0, 1)}</span><div className="flex items-center gap-1">{active > 0 ? <Badge><CircleDot className="mr-1 size-3" />{active} 工作中</Badge> : <Badge variant="secondary">空闲</Badge>}<Button variant="ghost" size="icon" className="size-7" title="编辑角色" onClick={() => setEditingRole(role)}><Settings2 className="size-3.5" /></Button></div></div><CardTitle className="mt-3">{role.name}</CardTitle><CardDescription className="line-clamp-2 min-h-10">{role.mission}</CardDescription></CardHeader><CardContent><div className="role-meta"><span><Bot className="size-3.5" />{model?.name ?? role.modelKey}</span><span><BrainCircuit className="size-3.5" />{role.reasoningEffort}</span><span><SquareArrowOutUpRight className="size-3.5" />{location}</span></div><div className="mt-4 flex items-center justify-between text-xs"><span className="text-muted-foreground">完成 {done}/{roleTasks.length}</span><span className="text-muted-foreground">并发 {active}/{role.concurrencyLimit}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${roleTasks.length ? done / roleTasks.length * 100 : 0}%`, background: role.color }} /></div></CardContent></Card>;
    })}{!project.roles.length && <InlineEmpty icon={Users} text="指挥模型正在组建 Team" />}</div>
    {editingRole && <RoleDialog role={project.roles.find((item) => item.id === editingRole.id) ?? editingRole} project={project} snapshot={snapshot} open onOpenChange={(open) => !open && setEditingRole(undefined)} />}
  </>;
}

function RoleDialog({ role, project, snapshot, open, onOpenChange }: { role: AgentRole; project: AgentProject; snapshot: AppSnapshot; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState<AgentRole>({ ...role });
  const model = snapshot.models.find((item) => item.modelKey === draft.modelKey);
  const levels = model?.supportsThinking ? model.reasoningLevels ?? reasoningLevels : ['off'] as ReasoningEffort[];
  const location = draft.spaceId ? `space:${draft.spaceId}` : draft.useWorkspace ? 'workspace' : '';
  const updateLocation = (value: string) => setDraft((current) => value === 'workspace'
    ? { ...current, spaceId: undefined, useWorkspace: true }
    : { ...current, spaceId: value.slice(6), useWorkspace: false });
  const save = () => {
    post({ type: 'agent-team:update-role', projectId: project.id, roleId: role.id, role: { ...draft, name: draft.name.trim(), mission: draft.mission.trim() } });
    onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle className="flex items-center gap-2"><Settings2 className="size-5" />编辑角色</DialogTitle><DialogDescription>修改会影响之后创建的 Worker Session；已经运行的 Turn 保持原配置。</DialogDescription></DialogHeader><div className="space-y-4"><div className="grid grid-cols-[1fr_72px] gap-4"><div className="space-y-2"><Label>角色名称</Label><Input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></div><div className="space-y-2"><Label>颜色</Label><input className="h-9 w-full rounded-md border border-input bg-background p-1" type="color" value={draft.color} onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))} /></div></div><div className="space-y-2"><Label>角色职责</Label><Textarea rows={3} value={draft.mission} onChange={(event) => setDraft((current) => ({ ...current, mission: event.target.value }))} /></div><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label>模型</Label><Select value={draft.modelKey} onChange={(event) => setDraft((current) => ({ ...current, modelKey: event.target.value }))}>{snapshot.models.map((item) => <option key={item.modelKey} value={item.modelKey}>{item.name} · {item.providerName}</option>)}</Select></div><div className="space-y-2"><Label>思考等级</Label><Select value={draft.reasoningEffort} onChange={(event) => setDraft((current) => ({ ...current, reasoningEffort: event.target.value as ReasoningEffort }))}>{levels.map((level) => <option key={level} value={level}>{level}</option>)}</Select></div></div><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label>工作位置</Label><Select value={location} onChange={(event) => updateLocation(event.target.value)}><option value="" disabled>请选择工作位置</option><option value="workspace" disabled={!project.workspaceAllowed}>默认工作间（非 Space）</option>{project.spaceIds.map((id) => snapshot.spaces.find((item) => item.id === id)).filter((item): item is NonNullable<typeof item> => Boolean(item)).map((space) => <option key={space.id} value={`space:${space.id}`}>Space · {space.name}</option>)}</Select></div><div className="space-y-2"><Label>角色并行上限</Label><Input type="number" min={1} max={8} value={draft.concurrencyLimit} onChange={(event) => setDraft((current) => ({ ...current, concurrencyLimit: Number(event.target.value) }))} /></div></div></div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={save} disabled={!draft.name.trim() || !draft.mission.trim() || !draft.modelKey || (!draft.spaceId && !draft.useWorkspace)}>保存角色</Button></DialogFooter></DialogContent></Dialog>;
}

function RunsView({ project, runs, tasks }: { project: AgentProject; runs: AgentRun[]; tasks: TeamTask[] }) {
  if (!runs.length) return <InlineEmpty icon={Clock3} text={project.status === 'planning' ? '规划 Session 正在创建' : '尚无运行记录'} subtext="Planner、Worker 和 Reviewer 的每次 Turn 都会显示在这里。" />;
  const kindLabel = { planner: '项目规划', worker: '任务执行', reviewer: '指挥验收' } as const;
  return <div className="mx-auto flex max-w-5xl flex-col gap-3">{[...runs].reverse().map((run) => {
    const task = tasks.find((item) => item.id === run.taskId);
    return <Card key={run.id}><CardContent className="flex items-center gap-3 p-4"><span className={cn('run-state-dot', run.state)} /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><strong className="text-sm">{kindLabel[run.kind]}</strong><Badge variant={run.state === 'failed' ? 'danger' : run.state === 'waiting' ? 'warning' : run.state === 'completed' ? 'positive' : 'secondary'}>{run.state}</Badge></div><div className="mt-1 truncate text-xs text-muted-foreground">{task?.title ?? (run.kind === 'planner' ? '生成项目草案' : '项目级运行')} · {formatTime(run.createdAt)} · {run.sessionId}</div>{run.modelKey && <div className="mt-1 truncate text-xs text-muted-foreground">实际模型：{run.modelKey} · 思考档位：{run.reasoningEffort ?? '默认'}</div>}{run.outputText && <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">{run.outputText}</div>}</div><Button variant="outline" size="sm" onClick={() => openSession(run.sessionId)}><SquareArrowOutUpRight className="size-4" />打开 Session</Button></CardContent></Card>;
  })}</div>;
}

function InboxView({ waits, tasks }: { waits: TeamWait[]; tasks: TeamTask[] }) {
  if (!waits.length) return <InlineEmpty icon={ShieldAlert} text="目前没有等待人类处理的事项" subtext="权限、问题和表单会集中出现在这里。" />;
  return <div className="mx-auto flex max-w-4xl flex-col gap-3">{waits.map((wait) => <WaitCard key={wait.requestId} wait={wait} task={tasks.find((task) => task.id === wait.taskId)} />)}</div>;
}

function WaitCard({ wait, task }: { wait: TeamWait; task?: TeamTask }) {
  const payload = wait.payload as Record<string, any>;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [formValues, setFormValues] = useState<Record<string, string | number | boolean | string[]>>({});
  const respond = (response: any) => post({ type: 'agent-team:respond-wait', sessionId: wait.sessionId, requestId: wait.requestId, response });
  return <Card className={cn('wait-card', wait.destructive && 'destructive')}><CardHeader className="pb-3"><div className="flex items-start gap-3"><div className="wait-icon">{wait.kind === 'permission' ? <ShieldAlert /> : wait.kind === 'question' ? <CircleDot /> : <ListChecks />}</div><div className="min-w-0 flex-1"><CardTitle className="text-base">{wait.title}</CardTitle><CardDescription className="mt-1">{task ? `任务：${task.title}` : '项目指挥'} · {formatTime(wait.createdAt)}</CardDescription></div>{wait.destructive && <Badge variant="danger">仅真人可批准</Badge>}</div></CardHeader><CardContent>
    {wait.kind === 'permission' && <div className="space-y-3"><pre className="wait-payload">{pretty(payload.toolInput)}</pre><div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => openSession(wait.sessionId)}><SquareArrowOutUpRight className="size-4" />打开 Session</Button><Button variant="destructive" size="sm" onClick={() => respond({ kind: 'permission', allow: false })}><XCircle className="size-4" />拒绝</Button>{!wait.destructive && <Button size="sm" onClick={() => respond({ kind: 'permission', allow: true })}><Check className="size-4" />允许本次</Button>}</div></div>}
    {wait.kind === 'question' && <div className="space-y-4">{(payload.questions ?? []).map((question: any) => <div key={question.header} className="space-y-2"><Label>{question.question}</Label><Select value={answers[question.header] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.header]: event.target.value }))}><option value="">请选择</option>{question.options.map((option: any) => <option key={option.label} value={option.label}>{option.label}</option>)}</Select></div>)}<div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => openSession(wait.sessionId)}>打开 Session</Button><Button size="sm" onClick={() => respond({ kind: 'question', answers })}>提交回答</Button></div></div>}
    {wait.kind === 'form' && <div className="space-y-3">{(payload.form?.fields ?? []).map((field: any) => <div key={field.key} className="space-y-2"><Label>{field.label}</Label>{field.type === 'boolean' ? <input type="checkbox" checked={formValues[field.key] === true} onChange={(event) => setFormValues((current) => ({ ...current, [field.key]: event.target.checked }))} /> : <Input value={String(formValues[field.key] ?? '')} placeholder={field.placeholder} onChange={(event) => setFormValues((current) => ({ ...current, [field.key]: event.target.value }))} />}</div>)}<div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => respond({ kind: 'form', submitted: false })}>取消表单</Button><Button size="sm" onClick={() => respond({ kind: 'form', submitted: true, values: formValues })}>提交表单</Button></div></div>}
  </CardContent></Card>;
}

function ActivityView({ activities, tasks }: { activities: AppSnapshot['activities']; tasks: TeamTask[] }) {
  if (!activities.length) return <InlineEmpty icon={Activity} text="项目活动会显示在这里" />;
  return <div className="activity-list">{activities.map((item) => <div className="activity-item" key={item.id}><span className={cn('activity-marker', item.kind)}>{item.kind === 'run' ? <Zap /> : item.kind === 'wait' ? <ShieldAlert /> : item.kind === 'task' ? <ListChecks /> : <Activity />}</span><div className="min-w-0 flex-1"><div className="text-sm">{item.message}</div><div className="mt-1 text-xs text-muted-foreground">{item.taskId && `${tasks.find((task) => task.id === item.taskId)?.title ?? '任务'} · `}{formatTime(item.createdAt)}</div></div></div>)}</div>;
}

function InlineEmpty({ icon: Icon, text, subtext }: { icon: typeof Users; text: string; subtext?: string }) {
  return <div className="inline-empty"><Icon className="size-7" /><div className="font-medium">{text}</div>{subtext && <p>{subtext}</p>}</div>;
}

function CreateProjectDialog({ open, onOpenChange, snapshot }: { open: boolean; onOpenChange: (open: boolean) => void; snapshot: AppSnapshot }) {
  const [brief, setBrief] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningEffort>('high');
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [workspaceAllowed, setWorkspaceAllowed] = useState(true);
  const [permissionMode, setPermissionMode] = useState<'ask' | 'acceptCalls'>('ask');
  const [maxConcurrency, setMaxConcurrency] = useState(3);
  useEffect(() => { if (!modelKey && snapshot.models[0]) setModelKey(snapshot.models[0].modelKey); }, [modelKey, snapshot.models]);
  const model = snapshot.models.find((item) => item.modelKey === modelKey);
  const levels = model?.supportsThinking ? model.reasoningLevels ?? reasoningLevels : ['off'] as ReasoningEffort[];
  useEffect(() => { if (!levels.includes(reasoning)) setReasoning(model?.defaultReasoningEffort ?? levels[0]); }, [modelKey]);
  const submit = () => {
    if (!brief.trim() || !modelKey) return;
    const input: ProjectDraftInput = { brief: brief.trim(), commanderModelKey: modelKey, commanderReasoningEffort: reasoning, spaceIds, workspaceAllowed, permissionMode, maxConcurrency };
    post({ type: 'agent-team:create-project', input });
    setBrief('');
    onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle className="flex items-center gap-2"><Sparkles className="size-5 text-[var(--accent)]" />AI 创建 Agent Team 项目</DialogTitle><DialogDescription>指挥模型会生成角色、模型分工、Workflow、任务依赖和验收标准。</DialogDescription></DialogHeader>
    <div className="space-y-5 py-2"><div className="space-y-2"><Label htmlFor="project-brief">项目需求</Label><Textarea id="project-brief" rows={5} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="例如：为现有 TypeScript 项目设计并实现用户邀请功能，包含调研、开发、测试和文档……" /></div>
      <div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label>指挥模型</Label><Select value={modelKey} onChange={(event) => setModelKey(event.target.value)}>{snapshot.models.map((item) => <option value={item.modelKey} key={item.modelKey}>{item.name} · {item.providerName}</option>)}</Select></div><div className="space-y-2"><Label>思考等级</Label><Select value={reasoning} onChange={(event) => setReasoning(event.target.value as ReasoningEffort)}>{levels.map((level) => <option value={level} key={level}>{level}</option>)}</Select></div></div>
      <div className="space-y-2"><Label>允许工作的地点</Label><div className="space-checks"><label className={cn('space-check', workspaceAllowed && 'selected')}><input type="checkbox" checked={workspaceAllowed} onChange={(event) => setWorkspaceAllowed(event.target.checked)} /><span><strong>默认工作间</strong><small>非 Space · Finch 全局默认工作目录</small></span></label>{snapshot.spaces.map((space) => <label key={space.id} className={cn('space-check', spaceIds.includes(space.id) && 'selected')}><input type="checkbox" checked={spaceIds.includes(space.id)} onChange={() => setSpaceIds((current) => current.includes(space.id) ? current.filter((id) => id !== space.id) : [...current, space.id])} /><span><strong>Space · {space.name}</strong><small>{space.directoryPath ?? '独立 Space'}</small></span></label>)}</div><p className="text-xs text-muted-foreground">每个角色必须使用已授权的 Space 或默认工作间；关闭默认工作间后，请为每个角色分配 Space。</p></div>
      <div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label>权限模式</Label><Select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as 'ask' | 'acceptCalls')}><option value="ask">ask · 需要确认</option><option value="acceptCalls">acceptCalls · 安全调用自动接受</option></Select></div><div className="space-y-2"><Label>项目并行上限</Label><Input type="number" min={1} max={8} value={maxConcurrency} onChange={(event) => setMaxConcurrency(Number(event.target.value))} /></div></div>
    </div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={submit} disabled={!brief.trim() || !modelKey || (!workspaceAllowed && spaceIds.length === 0)}><Sparkles className="size-4" />生成项目草案</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function WorkflowDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (open: boolean) => void; project: AgentProject }) {
  const [workflow, setWorkflow] = useState<WorkflowState[]>(project.workflow);
  useEffect(() => { if (open) setWorkflow(project.workflow.map((item) => ({ ...item }))); }, [open, project.workflow]);
  const update = (index: number, patch: Partial<WorkflowState>) => setWorkflow((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const save = () => { post({ type: 'agent-team:update-workflow', projectId: project.id, workflow }); onOpenChange(false); };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle className="flex items-center gap-2"><Workflow className="size-5" />Workflow 编辑器</DialogTitle><DialogDescription>定义看板列和底层类别。运行状态与这些业务状态相互独立。</DialogDescription></DialogHeader><div className="space-y-2">{workflow.map((state, index) => <div className="workflow-row" key={`${state.id}-${index}`}><span className="drag-handle">⋮⋮</span><input type="color" value={state.color} onChange={(event) => update(index, { color: event.target.value })} /><Input value={state.name} onChange={(event) => update(index, { name: event.target.value })} /><Select value={state.category} onChange={(event) => update(index, { category: event.target.value as WorkflowCategory })}>{workflowCategories.map((category) => <option key={category} value={category}>{category}</option>)}</Select><Button variant="ghost" size="icon" disabled={workflow.length <= 2} onClick={() => setWorkflow((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="size-4" /></Button></div>)}<Button variant="outline" size="sm" onClick={() => setWorkflow((current) => [...current, { id: `state-${Date.now()}`, name: '新状态', category: 'ready', color: '#64748b', order: current.length, terminal: false }])}><Plus className="size-4" />添加状态</Button></div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={save}>保存 Workflow</Button></DialogFooter></DialogContent></Dialog>;
}

function AddTaskDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (open: boolean) => void; project: AgentProject }) {
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [roleId, setRoleId] = useState(project.roles[0]?.id ?? '');
  useEffect(() => { if (open && !project.roles.some((role) => role.id === roleId)) setRoleId(project.roles[0]?.id ?? ''); }, [open, project.roles]);
  const submit = () => { if (!title.trim() || !roleId) return; post({ type: 'agent-team:add-task', projectId: project.id, task: { title: title.trim(), description: description.trim(), roleId } }); setTitle(''); setDescription(''); onOpenChange(false); };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>新增任务</DialogTitle><DialogDescription>任务进入 Workflow 起始列，项目运行时会自动检查依赖并调度。</DialogDescription></DialogHeader><div className="space-y-4"><div className="space-y-2"><Label>标题</Label><Input value={title} onChange={(event) => setTitle(event.target.value)} /></div><div className="space-y-2"><Label>执行说明</Label><Textarea value={description} onChange={(event) => setDescription(event.target.value)} /></div><div className="space-y-2"><Label>负责角色</Label><Select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{project.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</Select></div></div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button onClick={submit} disabled={!title.trim() || !roleId}>添加任务</Button></DialogFooter></DialogContent></Dialog>;
}

function TaskDialog({ task, project, runs, open, onOpenChange }: { task: TeamTask; project: AgentProject; runs: AgentRun[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const role = project.roles.find((item) => item.id === task.roleId);
  const activeRun = runs.find((run) => run.id === task.activeRunId);
  const currentState = project.workflow.find((item) => item.id === task.workflowStateId);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="w-[min(760px,calc(100vw-32px))]"><DialogHeader><div className="flex items-center gap-2"><Badge variant="outline"><span className="mr-1.5 size-2 rounded-full" style={{ background: currentState?.color }} />{currentState?.name}</Badge><Badge variant="secondary">P{task.priority}</Badge></div><DialogTitle className="pt-2">{task.title}</DialogTitle><DialogDescription>{task.description || '暂无执行说明'}</DialogDescription></DialogHeader>
    <div className="detail-grid"><div><span>负责角色</span><strong><span className="avatar" style={{ background: role?.color }}>{role?.name.slice(0, 1)}</span>{role?.name ?? '未分配'}</strong></div><div><span>执行次数</span><strong>{task.attempt}/{task.maxAttempts}</strong></div><div><span>依赖任务</span><strong>{task.dependencyIds.length}</strong></div><div><span>自动调度</span><strong>{task.autoStart ? '开启' : '关闭'}</strong></div></div>
    <div className="space-y-2"><Label>验收标准</Label><ul className="criteria-list">{task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => <li key={item}><Check className="size-3.5" />{item}</li>) : <li className="text-muted-foreground">未设置</li>}</ul></div>
    {task.reviewFeedback && <div className="feedback-box"><AlertTriangle className="size-4" /><div><strong>验收反馈</strong><p>{task.reviewFeedback}</p></div></div>}
    {task.latestSummary && <div className="space-y-2"><Label>最近汇报</Label><pre className="report-box">{task.latestSummary}</pre></div>}
    <div className="space-y-2"><Label>运行记录</Label><div className="run-history">{[...runs].reverse().map((run) => <div key={run.id}><span className={cn('run-state-dot', run.state)} /><span>{run.kind}</span><span className="text-muted-foreground">{formatTime(run.createdAt)}</span><Badge variant={run.state === 'failed' ? 'danger' : run.state === 'waiting' ? 'warning' : run.state === 'completed' ? 'positive' : 'secondary'}>{run.state}</Badge><Button variant="ghost" size="icon" className="ml-auto size-7" onClick={() => openSession(run.sessionId)}><SquareArrowOutUpRight className="size-3.5" /></Button></div>)}{!runs.length && <div className="p-3 text-xs text-muted-foreground">尚未运行</div>}</div></div>
    <DialogFooter className="flex-wrap"><Button variant="outline" onClick={() => runs[0] && openSession(runs[0].sessionId)} disabled={!runs.length}><SquareArrowOutUpRight className="size-4" />打开 Session</Button>{activeRun ? <Button variant="destructive" onClick={() => post({ type: 'agent-team:cancel-run', runId: activeRun.id })}><XCircle className="size-4" />取消 Turn</Button> : <Button onClick={() => post({ type: task.attempt ? 'agent-team:retry-task' : 'agent-team:start-task', taskId: task.id })}>{task.attempt ? <RotateCcw className="size-4" /> : <Play className="size-4" />}{task.attempt ? '重试' : '立即执行'}</Button>}</DialogFooter>
  </DialogContent></Dialog>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function pretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
