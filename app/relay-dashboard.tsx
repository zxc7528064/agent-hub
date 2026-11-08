"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronRight, Clipboard, Code2, Download, FileText, Menu, Paperclip, Plus, Send, ShieldCheck, Sparkles, Trash2, UserRound, X } from "lucide-react";
import { bytesLabel, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, MAX_TOTAL_ATTACHMENT_BYTES, type AttachmentView } from "../lib/attachments";

type Task = { id: string; title: string; status: string; originalRequest: string; createdAt: string; updatedAt: string };
type Message = { id: string; taskId: string; role: "user" | "kimi" | "codex"; body: string; createdAt: string; attachments: AttachmentView[] };

const roleMeta = {
  user: { label: "我", icon: UserRound, bubble: "bg-[#173f30] text-white", avatar: "bg-[#173f30] text-white" },
  kimi: { label: "Kimi", icon: Sparkles, bubble: "border border-[#dccdf7] bg-[#f4effd] text-[#3f315c]", avatar: "bg-[#7b5bb6] text-white" },
  codex: { label: "Codex", icon: Code2, bubble: "border border-[#c9dde8] bg-[#edf6fa] text-[#244659]", avatar: "bg-[#2d708a] text-white" },
};

function transcript(messages: Message[]) {
  return messages.map((message) => {
    const attachments = message.attachments.length > 0
      ? `\n\n附件：${message.attachments.map((attachment) => `${attachment.fileName} (${bytesLabel(attachment.size)})`).join("、")}`
      : "";
    return `[${roleMeta[message.role].label}]\n${message.body || "（只有附件）"}${attachments}`;
  }).join("\n\n---\n\n");
}

function promptForCodex(task: Task, messages: Message[]) {
  return `請針對下列 Kimi 開發對話做唯讀驗收。不要相信報告本身，請直接核對 repository、HEAD、diff、測試及 artifacts；不要修改檔案。證據不足不得判定 PASS。\n\n任務：${task.title}\n原始目標：${task.originalRequest || "未填寫"}\n\n對話紀錄：\n${transcript(messages)}\n\n請輸出：verdict（APPROVE / CHANGES_REQUIRED / BLOCKED）、verified_claims、discrepancies、risks、required_fixes，以及可直接送回 Kimi 的 next_kimi_prompt。`;
}

function promptForKimi(task: Task, messages: Message[]) {
  const review = [...messages].reverse().find((message) => message.role === "codex")?.body ?? transcript(messages);
  return `請依 Codex 的唯讀驗收結果修正「${task.title}」。不得擴張原任務範圍，不得覆蓋使用者未提交修改；先核對目前 HEAD 與工作區，再逐項處理 required_fixes。完成後請提供可重現命令、測試四數、commit、實際 diff 範圍與任何偏離。\n\nCodex 驗收結果：\n${review}`;
}

async function copy(value: string) { await navigator.clipboard.writeText(value); }

export default function RelayDashboard({ displayName }: { displayName: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [role, setRole] = useState<Message["role"]>("kimi");
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newGoal, setNewGoal] = useState("");
  const [creating, setCreating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => tasks.find((task) => task.id === selectedId) ?? tasks[0], [tasks, selectedId]);

  const loadTasks = useCallback(async () => {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    const data = (await response.json()) as { tasks?: Task[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "無法讀取對話");
    setTasks(data.tasks ?? []);
    setSelectedId((current) => current || data.tasks?.[0]?.id || "");
  }, []);

  const loadMessages = useCallback(async (taskId: string) => {
    const response = await fetch(`/api/tasks/${taskId}/messages`, { cache: "no-store" });
    const data = (await response.json()) as { messages?: Message[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "無法讀取訊息");
    setMessages(data.messages ?? []);
  }, []);

  useEffect(() => { void Promise.resolve().then(loadTasks).catch((error) => setNotice(error instanceof Error ? error.message : "讀取失敗")); }, [loadTasks]);
  useEffect(() => { if (selectedId) void Promise.resolve().then(() => loadMessages(selectedId)).catch((error) => setNotice(error instanceof Error ? error.message : "讀取失敗")); }, [selectedId, loadMessages]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  function addFiles(incoming: FileList | File[]) {
    const candidates = Array.from(incoming);
    if (candidates.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
      setNotice("單一附件不得超過 10 MB");
      return;
    }
    const next = [...pendingFiles, ...candidates];
    if (next.length > MAX_ATTACHMENT_COUNT) {
      setNotice(`每則訊息最多 ${MAX_ATTACHMENT_COUNT} 個附件`);
      return;
    }
    if (next.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
      setNotice("附件總大小不得超過 25 MB");
      return;
    }
    setPendingFiles(next);
  }

  async function createConversation() {
    if (!newTitle.trim()) return;
    setBusy(true);
    const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: newTitle, originalRequest: newGoal }) });
    const data = (await response.json()) as { task?: Task; error?: string };
    if (!response.ok || !data.task) { setNotice(data.error ?? "建立失敗"); setBusy(false); return; }
    setTasks((current) => [data.task!, ...current]);
    setSelectedId(data.task.id);
    setMessages([]);
    setDraft(""); setPendingFiles([]);
    setNewTitle(""); setNewGoal(""); setCreating(false); setSidebarOpen(false); setBusy(false); setNotice("新對話已建立");
  }

  async function addMessage() {
    if (!selected || (!draft.trim() && pendingFiles.length === 0)) return;
    setBusy(true);
    const form = new FormData();
    form.set("role", role);
    form.set("body", draft);
    for (const file of pendingFiles) form.append("files", file, file.name);
    const response = await fetch(`/api/tasks/${selected.id}/messages`, { method: "POST", body: form });
    const data = (await response.json()) as { message?: Message; error?: string };
    setBusy(false);
    if (!response.ok || !data.message) { setNotice(data.error ?? "加入失敗"); return; }
    setMessages((current) => [...current, data.message!]);
    setTasks((current) => current.map((task) => task.id === selected.id ? { ...task, updatedAt: data.message!.createdAt } : task));
    setDraft("");
    setPendingFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setRole(role === "kimi" ? "codex" : role === "codex" ? "kimi" : role);
  }

  async function handoff(target: "kimi" | "codex") {
    if (!selected) return;
    await copy(target === "codex" ? promptForCodex(selected, messages) : promptForKimi(selected, messages));
    setNotice(`已複製給 ${target === "codex" ? "Codex" : "Kimi"}`);
  }

  return (
    <main className="min-h-[100dvh] bg-[#e9eee9] p-0 text-[#17241d] sm:p-3">
      <div className="mx-auto grid h-[100dvh] max-w-[1500px] overflow-hidden bg-white shadow-[0_24px_80px_rgba(26,48,37,.14)] sm:h-[calc(100dvh-24px)] sm:rounded-[28px] lg:grid-cols-[310px_minmax(0,1fr)]">
        <aside className={`${sidebarOpen ? "flex" : "hidden"} absolute inset-0 z-40 flex-col border-r border-black/8 bg-[#f7f9f6] lg:static lg:flex`}>
          <div className="flex items-center justify-between border-b border-black/8 px-5 py-5">
            <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-2xl bg-[#173f30] text-white"><ChevronRight size={19}/></div><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#648071]">Agent Relay</p><h1 className="font-semibold">我的對話</h1></div></div>
            <button onClick={() => setSidebarOpen(false)} className="rounded-xl p-2 hover:bg-black/5 lg:hidden" aria-label="關閉對話清單"><X size={20}/></button>
          </div>
          <div className="p-4"><button onClick={() => setCreating((value) => !value)} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#173f30] px-4 py-3 text-sm font-semibold text-white"><Plus size={17}/>新增對話</button></div>
          {creating && <div className="mx-4 mb-3 space-y-2 rounded-2xl border border-black/8 bg-white p-3 shadow-sm"><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="對話名稱" className="w-full rounded-xl border border-black/10 px-3 py-2.5 text-sm outline-none focus:border-[#31785c]"/><textarea value={newGoal} onChange={(event) => setNewGoal(event.target.value)} placeholder="這次要完成什麼？" rows={3} className="w-full resize-none rounded-xl border border-black/10 px-3 py-2.5 text-sm outline-none focus:border-[#31785c]"/><button disabled={busy || !newTitle.trim()} onClick={createConversation} className="w-full rounded-xl bg-[#dff0e7] px-3 py-2 text-sm font-semibold text-[#174c37] disabled:opacity-40">建立</button></div>}
          <div className="scrollbar-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4">
            {tasks.length === 0 && <p className="px-4 py-8 text-center text-sm leading-6 text-[#77847d]">新增一個對話，然後把 Kimi 的完成報告貼進來。</p>}
            {tasks.map((task) => <button key={task.id} onClick={() => { setSelectedId(task.id); setDraft(""); setPendingFiles([]); setSidebarOpen(false); }} className={`w-full rounded-2xl px-4 py-3 text-left transition ${selected?.id === task.id ? "bg-[#e3f0e8]" : "hover:bg-black/4"}`}><div className="mb-1 flex items-center gap-2"><span className={`size-2 rounded-full ${selected?.id === task.id ? "bg-[#1d7653]" : "bg-[#bdc8c0]"}`}/><span className="truncate text-sm font-semibold">{task.title}</span></div><p className="truncate pl-4 text-xs text-[#718078]">{task.originalRequest || "尚未設定目標"}</p></button>)}
          </div>
          <div className="border-t border-black/8 px-5 py-4 text-xs text-[#75827b]"><ShieldCheck size={14} className="mr-1.5 inline text-[#277756]"/>私人空間 · {displayName}</div>
        </aside>

        <section className="flex min-w-0 flex-col bg-[radial-gradient(circle_at_top,#f8fbf7_0,#f3f6f2_46%,#eef2ed_100%)]">
          <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-black/8 bg-white/80 px-4 backdrop-blur-xl sm:px-6">
            <div className="flex min-w-0 items-center gap-3"><button onClick={() => setSidebarOpen(true)} className="rounded-xl p-2 hover:bg-black/5 lg:hidden" aria-label="開啟對話清單"><Menu size={20}/></button><div className="min-w-0"><h2 className="truncate font-semibold">{selected?.title ?? "Kimi × Codex 對話"}</h2><p className="mt-0.5 text-xs text-[#718078]">手動中繼 · 每一步由你確認</p></div></div>
            <div className="flex items-center -space-x-2"><AgentDot role="kimi"/><AgentDot role="codex"/></div>
          </header>

          {selected ? <>
            <div className="scrollbar-thin flex-1 overflow-y-auto px-3 py-6 sm:px-8"><div className="mx-auto max-w-3xl space-y-5">
              <div className="mx-auto max-w-xl rounded-2xl border border-[#cfe2d6] bg-white/75 px-4 py-3 text-center text-xs leading-5 text-[#5b7166] shadow-sm"><ShieldCheck size={14} className="mr-1 inline text-[#287456]"/>這裡只保存對話，不會自動呼叫 Agent。貼上回覆後，再按交接按鈕。</div>
              {selected.originalRequest && <div className="flex justify-end"><div className="max-w-[88%] rounded-[22px] rounded-br-md bg-[#173f30] px-4 py-3 text-sm leading-6 text-white shadow-sm"><p className="mb-1 text-[10px] font-bold uppercase tracking-[.14em] text-[#a9cbbb]">最初目標</p><p className="whitespace-pre-wrap">{selected.originalRequest}</p></div></div>}
              {messages.length === 0 && <div className="grid min-h-[270px] place-items-center text-center"><div><div className="mx-auto mb-4 flex w-fit items-center gap-2"><AgentDot role="kimi" large/><ChevronRight className="text-[#9caaa2]"/><AgentDot role="codex" large/></div><h3 className="text-lg font-semibold">從 Kimi 的回覆開始</h3><p className="mt-2 text-sm text-[#718078]">貼在下方輸入框，來源選 Kimi，再加入對話。</p></div></div>}
              {messages.map((message) => <ChatBubble key={message.id} message={message} onHandoff={handoff}/>)}<div ref={endRef}/>
            </div></div>
            <div className="shrink-0 border-t border-black/8 bg-white/88 p-3 backdrop-blur-xl sm:p-5"><div className="mx-auto max-w-3xl">
              <div className="mb-2 flex items-center gap-1.5 overflow-x-auto">{(["kimi", "codex", "user"] as const).map((item) => { const Meta = roleMeta[item]; const Icon = Meta.icon; return <button key={item} onClick={() => setRole(item)} className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition ${role === item ? "bg-[#173f30] text-white" : "bg-[#edf1ed] text-[#66756d] hover:bg-[#e3e9e4]"}`}><Icon size={13}/>{item === "user" ? "我的補充" : `來自 ${Meta.label}`}</button>; })}</div>
              {pendingFiles.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{pendingFiles.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`} className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-black/8 bg-white px-3 py-2 text-xs shadow-sm"><FileText size={15} className="shrink-0 text-[#39745b]"/><span className="max-w-48 truncate font-medium">{file.name}</span><span className="shrink-0 text-[#7b8780]">{bytesLabel(file.size)}</span><button type="button" onClick={() => setPendingFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded-md p-1 text-[#7b8780] hover:bg-red-50 hover:text-red-700" aria-label={`移除 ${file.name}`}><Trash2 size={13}/></button></div>)}</div>}
              <div onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }} className="flex items-end gap-2 rounded-[22px] border border-black/10 bg-white p-2 pl-2 shadow-[0_10px_35px_rgba(31,50,40,.08)] focus-within:border-[#347b5e]"><input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }}/><button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy || pendingFiles.length >= MAX_ATTACHMENT_COUNT} className="grid size-10 shrink-0 place-items-center rounded-xl text-[#52675c] hover:bg-[#edf3ef] disabled:opacity-35" aria-label="新增附件" title="新增附件"><Paperclip size={18}/></button><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void addMessage(); }} rows={3} placeholder={`貼上${role === "user" ? "你的補充" : `${roleMeta[role].label} 的回覆`}，或拖放檔案…`} className="max-h-44 min-h-[68px] flex-1 resize-none bg-transparent py-2 text-sm leading-6 outline-none"/><button disabled={busy || (!draft.trim() && pendingFiles.length === 0)} onClick={addMessage} className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[#173f30] text-white disabled:opacity-35" aria-label="加入對話"><Send size={18}/></button></div>
              <p className="mt-2 text-center text-[11px] text-[#86918b]">⌘/Ctrl + Enter 加入 · 最多 5 個附件，單檔 10 MB · 交接時需在目標 Agent 重新附加原檔</p>
            </div></div>
          </> : <div className="grid flex-1 place-items-center p-8 text-center"><div><div className="mx-auto mb-4 grid size-16 place-items-center rounded-[22px] bg-[#dfece4] text-[#1d6649]"><Bot size={28}/></div><h2 className="text-xl font-semibold">建立第一個對話</h2><p className="mt-2 text-sm text-[#718078]">打開左側選單，新增一個任務。</p><button onClick={() => { setSidebarOpen(true); setCreating(true); }} className="mt-5 rounded-2xl bg-[#173f30] px-5 py-3 text-sm font-semibold text-white">新增對話</button></div></div>}
        </section>
      </div>
      {(notice || busy) && <button onClick={() => setNotice("")} className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#17241d] px-4 py-2.5 text-sm text-white shadow-xl">{busy ? "儲存中…" : notice}</button>}
    </main>
  );
}

function AgentDot({ role, large = false }: { role: "kimi" | "codex"; large?: boolean }) {
  const Meta = roleMeta[role]; const Icon = Meta.icon;
  return <div title={Meta.label} className={`grid ${large ? "size-14" : "size-9"} place-items-center rounded-2xl border-2 border-white ${Meta.avatar} shadow-sm`}><Icon size={large ? 22 : 15}/></div>;
}

function ChatBubble({ message, onHandoff }: { message: Message; onHandoff: (target: "kimi" | "codex") => Promise<void> }) {
  const Meta = roleMeta[message.role]; const Icon = Meta.icon; const own = message.role === "user";
  return <div className={`flex gap-3 ${own ? "justify-end" : "justify-start"}`}>{!own && <div className={`mt-1 grid size-9 shrink-0 place-items-center rounded-2xl ${Meta.avatar}`}><Icon size={15}/></div>}<div className={`max-w-[86%] sm:max-w-[78%] ${own ? "items-end" : "items-start"} flex flex-col`}><div className="mb-1 px-1 text-[11px] font-semibold text-[#718078]">{Meta.label}</div><div className={`rounded-[22px] px-4 py-3 text-sm leading-6 shadow-sm ${own ? "rounded-br-md" : "rounded-bl-md"} ${Meta.bubble}`}>{message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}{message.attachments.length > 0 && <div className={`${message.body ? "mt-3 border-t border-current/15 pt-3" : ""} space-y-2`}>{message.attachments.map((attachment) => <a key={attachment.id} href={`/api/tasks/${message.taskId}/attachments/${attachment.id}`} className="flex min-w-0 items-center gap-2 rounded-xl bg-white/55 px-3 py-2 text-xs hover:bg-white/80"><FileText size={15} className="shrink-0"/><span className="min-w-0 flex-1 truncate font-semibold">{attachment.fileName}</span><span className="shrink-0 opacity-65">{bytesLabel(attachment.size)}</span><Download size={14} className="shrink-0"/></a>)}</div>}</div>{message.role !== "user" && <button onClick={() => onHandoff(message.role === "kimi" ? "codex" : "kimi")} className="mt-2 flex items-center gap-1.5 rounded-full bg-white/85 px-3 py-1.5 text-xs font-semibold text-[#52675c] shadow-sm ring-1 ring-black/6 hover:bg-white"><Clipboard size={12}/>{message.role === "kimi" ? "複製給 Codex 驗收" : "複製給 Kimi 修正"}<Check size={12} className="text-[#2b7a58]"/></button>}</div>{own && <div className={`mt-1 grid size-9 shrink-0 place-items-center rounded-2xl ${Meta.avatar}`}><Icon size={15}/></div>}</div>;
}
