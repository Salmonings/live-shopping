"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import io from "socket.io-client";

type Branch = { id: string; name: string };
type CustomerInfo = { name: string; phone: string; address: string };
type TakerRow = {
  socketId: string;
  userId: string;
  branchId: string | null;
  status: "in_call" | "available" | "not_available";
  currentCustomer: CustomerInfo;
  previousCustomer: CustomerInfo;
  callStartedAt?: number;
};
type MonitorPayload = {
  counts: { totalConnections: number; totalOrderTakers: number };
  takers: TakerRow[];
};
type RecordingFile = { type: string; filename: string; path: string };
type RecordingEntry = {
  callId: string;
  timestamp: string;
  date: string;
  orderTaker: string;
  branchId: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  duration: string;
  files: RecordingFile[];
};

const t = {
  dashboard: { en: "📊 Manager Dashboard", ar: "لوحة تحكم المدير 📊" },
  signIn: { en: "Manager Dashboard", ar: "لوحة تحكم المدير" },
  signInSub: {
    en: "Sign in to monitor all branches",
    ar: "سجّل دخولك لمراقبة جميع الفروع",
  },
  managerId: { en: "Manager ID", ar: "رقم المدير" },
  password: { en: "Password", ar: "كلمة المرور" },
  login: { en: "Login", ar: "دخول" },
  updated: { en: "Updated", ar: "آخر تحديث" },
  waiting: { en: "Waiting for data...", ar: "في انتظار البيانات..." },
  liveMonitor: { en: "📡 Live Monitor", ar: "📡 المراقبة المباشرة" },
  recordings: { en: "🎙️ Recordings", ar: "🎙️ التسجيلات" },
  activeCalls: { en: "Active Calls", ar: "المكالمات النشطة" },
  available: { en: "Available", ar: "متاح" },
  offline: { en: "Offline", ar: "غير متاح" },
  totalTakers: { en: "Total Takers", ar: "إجمالي الموظفين" },
  allBranches: { en: "All Branches", ar: "جميع الفروع" },
  noTakers: { en: "No order takers online", ar: "لا يوجد موظفون متصلون" },
  nobodyYet: { en: "Nobody has logged in yet", ar: "لم يسجّل أحد دخوله بعد" },
  nobodyAt: { en: "Nobody online at", ar: "لا أحد متصل في" },
  inCall: { en: "In Call", ar: "في مكالمة" },
  inCallBadge: { en: "In Call", ar: "في مكالمة" },
  availableBadge: { en: "Available", ar: "متاح" },
  offlineBadge: { en: "Offline", ar: "غير متاح" },
  currentCustomer: { en: "Current Customer", ar: "العميل الحالي" },
  prevCustomer: { en: "Previous Customer", ar: "العميل السابق" },
  loadingRec: { en: "Loading recordings...", ar: "جارٍ تحميل التسجيلات..." },
  allBranchesOpt: { en: "All Branches", ar: "جميع الفروع" },
  noRecordings: { en: "No recordings found", ar: "لا توجد تسجيلات" },
  recSub: {
    en: "Recordings appear here after calls end",
    ar: "تظهر التسجيلات هنا بعد انتهاء المكالمات",
  },
  dateTime: { en: "Date & Time", ar: "التاريخ والوقت" },
  orderTaker: { en: "Order Taker", ar: "الموظف" },
  branch: { en: "Branch", ar: "الفرع" },
  customer: { en: "Customer", ar: "العميل" },
  duration: { en: "Duration", ar: "المدة" },
  files: { en: "Files", ar: "الملفات" },
  deleteConfirm: {
    en: "Delete this recording? This cannot be undone.",
    ar: "حذف هذا التسجيل؟ لا يمكن التراجع عن هذا.",
  },
  deleteFailed: { en: "Delete failed", ar: "فشل الحذف" },
};

function useCallDuration(
  callStartedAt: number | undefined,
  active: boolean,
): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || !callStartedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active, callStartedAt]);
  if (!active || !callStartedAt) return "";
  const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
}

function TakerCard({
  taker,
  branchName,
}: {
  taker: TakerRow;
  branchName: (id: string | null) => string;
}) {
  const duration = useCallDuration(
    taker.callStartedAt,
    taker.status === "in_call",
  );
  const sc = {
    in_call: "in-call",
    available: "available",
    not_available: "offline",
  }[taker.status];
  const labelEn = {
    in_call: t.inCallBadge.en,
    available: t.availableBadge.en,
    not_available: t.offlineBadge.en,
  }[taker.status];
  const labelAr = {
    in_call: t.inCallBadge.ar,
    available: t.availableBadge.ar,
    not_available: t.offlineBadge.ar,
  }[taker.status];

  return (
    <article className={`taker-card ${sc}`}>
      <div className="taker-card-header">
        <div>
          <div className="taker-name">{taker.userId}</div>
          <div className="taker-branch">{branchName(taker.branchId)}</div>
        </div>
        <div className="taker-badges">
          <span className={`status-badge ${sc}`}>
            {labelEn} / <span className="ar">{labelAr}</span>
          </span>
          {taker.status === "in_call" && duration && (
            <span className="call-timer">⏱ {duration}</span>
          )}
        </div>
      </div>
      <div className="taker-divider" />
      <div className="taker-section">
        <div className="taker-section-label">
          {t.currentCustomer.en} /{" "}
          <span className="ar">{t.currentCustomer.ar}</span>
        </div>
        {taker.currentCustomer.name ? (
          <>
            <div className="taker-customer-name">
              {taker.currentCustomer.name}
            </div>
            <div className="taker-customer-address">
              ☎️ {taker.currentCustomer.phone || "—"}
            </div>
            <div className="taker-customer-address">
              📍 {taker.currentCustomer.address || "—"}
            </div>
          </>
        ) : (
          <div className="taker-empty">—</div>
        )}
      </div>
      <div className="taker-divider" />
      <div className="taker-section">
        <div className="taker-section-label">
          {t.prevCustomer.en} / <span className="ar">{t.prevCustomer.ar}</span>
        </div>
        {taker.previousCustomer.name ? (
          <>
            <div className="taker-prev-name">{taker.previousCustomer.name}</div>
            <div className="taker-prev-address">
              📍 {taker.previousCustomer.address || "—"}
            </div>
          </>
        ) : (
          <div className="taker-empty">—</div>
        )}
      </div>
    </article>
  );
}

function RecordingsTab({ branches }: { branches: Branch[] }) {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterBranch, setFilterBranch] = useState("all");
  const [filterDate, setFilterDate] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/recordings")
      .then((r) => r.json())
      .then((data) => {
        setRecordings(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = recordings.filter((r) => {
    if (filterBranch !== "all" && r.branchId !== filterBranch) return false;
    if (filterDate && !r.date.startsWith(filterDate)) return false;
    return true;
  });

  const deleteRec = async (callId: string) => {
    if (!confirm(`${t.deleteConfirm.en}\n${t.deleteConfirm.ar}`)) return;
    setDeleting(callId);
    try {
      await fetch(`/api/recordings/${callId}`, { method: "DELETE" });
      setRecordings((prev) => prev.filter((r) => r.callId !== callId));
    } catch {
      alert(`${t.deleteFailed.en} / ${t.deleteFailed.ar}`);
    }
    setDeleting(null);
  };

  const getFile = (r: RecordingEntry, type: string) =>
    r.files.find((f) => f.type === type);

  if (loading)
    return (
      <div className="dashboard-empty">
        <div className="empty-sub">
          {t.loadingRec.en} / <span className="ar">{t.loadingRec.ar}</span>
        </div>
      </div>
    );

  return (
    <div style={{ padding: "0 24px 32px" }}>
      <div className="recordings-filters">
        <select
          className="rec-filter-select"
          value={filterBranch}
          onChange={(e) => setFilterBranch(e.target.value)}
        >
          <option value="all">
            {t.allBranchesOpt.en} / {t.allBranchesOpt.ar}
          </option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          className="rec-filter-input"
          type="month"
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
        />
        <span className="rec-count">
          {filtered.length} recording{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="dashboard-empty">
          <div className="empty-icon">🎙️</div>
          <div className="empty-title">
            {t.noRecordings.en} /{" "}
            <span className="ar">{t.noRecordings.ar}</span>
          </div>
          <div className="empty-sub">
            {t.recSub.en}
            <br />
            <span className="ar">{t.recSub.ar}</span>
          </div>
        </div>
      ) : (
        <div className="recordings-table-wrap">
          <table className="recordings-table">
            <thead>
              <tr>
                <th>
                  {t.dateTime.en} / <span className="ar">{t.dateTime.ar}</span>
                </th>
                <th>
                  {t.orderTaker.en} /{" "}
                  <span className="ar">{t.orderTaker.ar}</span>
                </th>
                <th>
                  {t.branch.en} / <span className="ar">{t.branch.ar}</span>
                </th>
                <th>
                  {t.customer.en} / <span className="ar">{t.customer.ar}</span>
                </th>
                <th>
                  {t.duration.en} / <span className="ar">{t.duration.ar}</span>
                </th>
                <th>
                  {t.files.en} / <span className="ar">{t.files.ar}</span>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const dt = new Date(r.timestamp);
                const combined = getFile(r, "combined");
                const otFile = getFile(r, "ordertaker");
                const custFile = getFile(r, "customer");
                const isPlaying = playing === r.callId;
                return (
                  <tr key={r.callId}>
                    <td>
                      <div className="rec-date">{dt.toLocaleDateString()}</div>
                      <div className="rec-time">
                        {dt.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </td>
                    <td className="rec-taker">{r.orderTaker}</td>
                    <td className="rec-branch">
                      {branches.find((b) => b.id === r.branchId)?.name ||
                        r.branchId}
                    </td>
                    <td>
                      <div className="rec-customer-name">
                        {r.customerName || "—"}
                      </div>
                      {r.customerPhone && (
                        <div className="rec-customer-sub">
                          ☎️ {r.customerPhone}
                        </div>
                      )}
                      {r.customerAddress && (
                        <div className="rec-customer-sub">
                          📍 {r.customerAddress}
                        </div>
                      )}
                    </td>
                    <td className="rec-duration">{r.duration || "—"}</td>
                    <td>
                      <div className="rec-file-btns">
                        {combined && (
                          <a
                            className="rec-file-btn combined"
                            href={`/api/recordings/file/${combined.path}`}
                            download
                          >
                            🎬 Combined
                          </a>
                        )}
                        {otFile && (
                          <a
                            className="rec-file-btn ordertaker"
                            href={`/api/recordings/file/${otFile.path}`}
                            download
                          >
                            📹 Taker
                          </a>
                        )}
                        {custFile && (
                          <a
                            className="rec-file-btn customer"
                            href={`/api/recordings/file/${custFile.path}`}
                            download
                          >
                            🎤 Customer
                          </a>
                        )}
                      </div>
                      {isPlaying && combined && (
                        <div className="rec-player-wrap">
                          <video
                            src={`/api/recordings/file/${combined.path}`}
                            controls
                            autoPlay
                            style={{
                              width: "100%",
                              borderRadius: 8,
                              marginTop: 8,
                            }}
                          />
                          <button
                            className="rec-close-player"
                            onClick={() => setPlaying(null)}
                          >
                            ✕ Close
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="rec-actions">
                        {combined && (
                          <button
                            className="rec-action-btn play"
                            onClick={() =>
                              setPlaying(isPlaying ? null : r.callId)
                            }
                          >
                            {isPlaying ? "⏹" : "▶"}
                          </button>
                        )}
                        <button
                          className="rec-action-btn delete"
                          onClick={() => deleteRec(r.callId)}
                          disabled={deleting === r.callId}
                        >
                          {deleting === r.callId ? "..." : "🗑"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ManagerPage() {
  const socketRef = useRef<any>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState("all");
  const [activeTab, setActiveTab] = useState<"live" | "recordings">("live");
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [monitor, setMonitor] = useState<MonitorPayload>({
    counts: { totalConnections: 0, totalOrderTakers: 0 },
    takers: [],
  });

  useEffect(() => {
    const socket = io();
    socketRef.current = socket;
    socket.on("branches", (list: Branch[]) => {
      setBranches(Array.isArray(list) ? list : []);
    });
    socket.on("monitor-update", (payload: MonitorPayload) => {
      setMonitor(
        payload || {
          counts: { totalConnections: 0, totalOrderTakers: 0 },
          takers: [],
        },
      );
      setLastUpdated(new Date());
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  const doLogin = () => {
    setLoginError("");
    socketRef.current?.emit(
      "login",
      { userId, password, role: "manager" },
      (res: any) => {
        if (!res?.ok) {
          setLoginError(res?.error || "Login failed");
          return;
        }
        setLoggedIn(true);
        socketRef.current?.emit("manager-monitor-subscribe");
      },
    );
  };

  const branchName = useCallback(
    (id: string | null) =>
      branches.find((b) => b.id === id)?.name || id || "Unknown",
    [branches],
  );
  const filteredTakers = useMemo(
    () =>
      selectedBranch === "all"
        ? monitor.takers
        : monitor.takers.filter((t) => t.branchId === selectedBranch),
    [monitor.takers, selectedBranch],
  );
  const filteredCounts = useMemo(() => {
    if (selectedBranch === "all") return monitor.counts;
    return {
      totalOrderTakers: filteredTakers.length,
      totalConnections: filteredTakers.filter((t) => t.status === "in_call")
        .length,
    };
  }, [monitor.counts, filteredTakers, selectedBranch]);

  if (!loggedIn) {
    return (
      <div className="dashboard-login">
        <div className="dashboard-login-card">
          <h2>
            {t.signIn.en}
            <br />
            <span className="ar" style={{ fontSize: 18 }}>
              {t.signIn.ar}
            </span>
          </h2>
          <div className="login-sub">
            {t.signInSub.en}
            <br />
            <span className="ar">{t.signInSub.ar}</span>
          </div>
          <div className="login-field">
            <label className="field-label">
              {t.managerId.en} / <span className="ar">{t.managerId.ar}</span>
            </label>
            <input
              placeholder="e.g. manager1"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
            />
          </div>
          <div className="login-field">
            <label className="field-label">
              {t.password.en} / <span className="ar">{t.password.ar}</span>
            </label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
            />
          </div>
          <button className="login-btn" onClick={doLogin}>
            {t.login.en} / <span className="ar">{t.login.ar}</span>
          </button>
          {loginError && <div className="dashboard-error">{loginError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-topbar">
        <h2>
          {t.dashboard.en} / <span className="ar">{t.dashboard.ar}</span>
        </h2>
        <span className="updated">
          {lastUpdated
            ? `${t.updated.en} ${lastUpdated.toLocaleTimeString()}`
            : `${t.waiting.en} / ${t.waiting.ar}`}
        </span>
      </div>

      <div className="dashboard-main-tabs">
        <button
          className={`main-tab${activeTab === "live" ? " active" : ""}`}
          onClick={() => setActiveTab("live")}
        >
          {t.liveMonitor.en} / <span className="ar">{t.liveMonitor.ar}</span>
        </button>
        <button
          className={`main-tab${activeTab === "recordings" ? " active" : ""}`}
          onClick={() => setActiveTab("recordings")}
        >
          {t.recordings.en} / <span className="ar">{t.recordings.ar}</span>
        </button>
      </div>

      {activeTab === "live" && (
        <>
          <div className="dashboard-stats">
            <div className="dashboard-stat blue">
              <div className="stat-value">
                {filteredCounts.totalConnections}
              </div>
              <div className="stat-key">
                {t.activeCalls.en} /{" "}
                <span className="ar">{t.activeCalls.ar}</span>
              </div>
            </div>
            <div className="dashboard-stat green">
              <div className="stat-value">
                {filteredTakers.filter((t) => t.status === "available").length}
              </div>
              <div className="stat-key">
                {t.available.en} / <span className="ar">{t.available.ar}</span>
              </div>
            </div>
            <div className="dashboard-stat gray">
              <div className="stat-value">
                {
                  filteredTakers.filter((t) => t.status === "not_available")
                    .length
                }
              </div>
              <div className="stat-key">
                {t.offline.en} / <span className="ar">{t.offline.ar}</span>
              </div>
            </div>
            <div className="dashboard-stat purple">
              <div className="stat-value">
                {filteredCounts.totalOrderTakers}
              </div>
              <div className="stat-key">
                {t.totalTakers.en} /{" "}
                <span className="ar">{t.totalTakers.ar}</span>
              </div>
            </div>
          </div>

          <div className="dashboard-tabs">
            {[
              { id: "all", name: `${t.allBranches.en} / ${t.allBranches.ar}` },
              ...branches,
            ].map((b) => {
              const active = selectedBranch === b.id;
              const count =
                b.id === "all"
                  ? monitor.takers.length
                  : monitor.takers.filter((tk) => tk.branchId === b.id).length;
              return (
                <button
                  key={b.id}
                  className={`dashboard-tab${active ? " active" : ""}`}
                  onClick={() => setSelectedBranch(b.id)}
                >
                  {b.name}
                  {count > 0 && <span className="tab-count">{count}</span>}
                </button>
              );
            })}
          </div>

          {filteredTakers.length === 0 ? (
            <div className="dashboard-empty">
              <div className="empty-icon">📭</div>
              <div className="empty-title">
                {t.noTakers.en} / <span className="ar">{t.noTakers.ar}</span>
              </div>
              <div className="empty-sub">
                {selectedBranch === "all" ? (
                  <>
                    {t.nobodyYet.en} /{" "}
                    <span className="ar">{t.nobodyYet.ar}</span>
                  </>
                ) : (
                  <>
                    {t.nobodyAt.en} {branchName(selectedBranch)} /{" "}
                    <span className="ar">
                      {t.nobodyAt.ar} {branchName(selectedBranch)}
                    </span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="dashboard-grid">
              {filteredTakers.map((taker) => (
                <TakerCard
                  key={taker.socketId}
                  taker={taker}
                  branchName={branchName}
                />
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === "recordings" && <RecordingsTab branches={branches} />}
    </div>
  );
}
