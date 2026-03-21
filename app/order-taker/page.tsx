"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import { useCallDuration } from "../useCallDuration";

type Branch = { id: string; name: string };
type CustomerDetails = { name: string; phone?: string; address: string };

const t = {
  title: { en: "📹 Order Taker", ar: "موظف الطلبات 📹" },
  signIn: { en: "Sign In", ar: "تسجيل الدخول" },
  signInSub: {
    en: "Log in to start taking orders",
    ar: "سجّل دخولك لبدء استقبال الطلبات",
  },
  employeeId: { en: "Employee ID", ar: "رقم الموظف" },
  idPlaceholder: { en: "e.g. ahmed", ar: "مثال: أحمد" },
  password: { en: "Password", ar: "كلمة المرور" },
  branch: { en: "Branch", ar: "الفرع" },
  selectBranch: { en: "Select your branch", ar: "اختر فرعك" },
  login: { en: "Login", ar: "دخول" },
  goAvailable: { en: "🟢 Go Available", ar: "🟢 متاح للطلبات" },
  waiting: { en: "⏳ Waiting for a customer...", ar: "⏳ في انتظار عميل..." },
  goOffline: { en: "⛔ Go Offline", ar: "⛔ غير متاح" },
  incomingOrder: { en: "Incoming Order", ar: "طلب وارد" },
  customer: { en: "Customer", ar: "العميل" },
  phoneNum: { en: "Phone Number", ar: "رقم الهاتف" },
  deliveryAddr: { en: "Delivery Address", ar: "عنوان التوصيل" },
  acceptCall: { en: "✓ Accept Call", ar: "✓ قبول المكالمة" },
  decline: { en: "✕ Decline", ar: "✕ رفض" },
  mute: { en: "Mute", ar: "كتم" },
  unmute: { en: "Unmute", ar: "إلغاء كتم" },
  camOff: { en: "Cam Off", ar: "إيقاف الكاميرا" },
  camOn: { en: "Cam On", ar: "تشغيل الكاميرا" },
  flip: { en: "Flip", ar: "تدوير" },
  end: { en: "End", ar: "إنهاء" },
  savingRec: { en: "Saving Recording", ar: "جارٍ حفظ التسجيل" },
  pleaseWait: { en: "Please wait...", ar: "يرجى الانتظار..." },
  dontClose: { en: "Do not close this tab", ar: "لا تغلق هذا التبويب" },
  enableRingtone: { en: "🔔 Enable Ringtone", ar: "🔔 تفعيل نغمة الرنين" },
  custDisconnected: { en: "Customer disconnected", ar: "انقطع اتصال العميل" },
  waiting2: { en: "Waiting", ar: "في الانتظار" },
  inCall: { en: "In Call", ar: "في مكالمة" },
  prevCustomer: { en: "Previous Customer", ar: "العميل السابق" },
  selectBranchErr: { en: "Please select a branch", ar: "يرجى اختيار الفرع" },
};

function getMimeType(): string {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";
}

interface Recorders {
  combined: MediaRecorder;
  orderTaker: MediaRecorder;
  customer: MediaRecorder;
  combinedChunks: Blob[];
  orderTakerChunks: Blob[];
  customerChunks: Blob[];
}

function startRecording(
  localStream: MediaStream,
  remoteStream: MediaStream,
): Recorders | null {
  try {
    const mimeType = getMimeType();
    const ctx = new AudioContext();
    const localSrc = ctx.createMediaStreamSource(localStream);
    const remoteSrc = ctx.createMediaStreamSource(remoteStream);
    const dest = ctx.createMediaStreamDestination();
    localSrc.connect(dest);
    remoteSrc.connect(dest);
    const combinedStream = new MediaStream([
      ...localStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
    const orderTakerStream = new MediaStream([
      ...localStream.getVideoTracks(),
      ...localStream.getAudioTracks(),
    ]);
    const customerStream = new MediaStream([...remoteStream.getAudioTracks()]);
    const combinedChunks: Blob[] = [];
    const orderTakerChunks: Blob[] = [];
    const customerChunks: Blob[] = [];
    const combined = new MediaRecorder(combinedStream, { mimeType });
    const orderTaker = new MediaRecorder(orderTakerStream, { mimeType });
    const customer = new MediaRecorder(customerStream, {
      mimeType: "audio/webm",
    });
    combined.ondataavailable = (e) => {
      if (e.data.size > 0) combinedChunks.push(e.data);
    };
    orderTaker.ondataavailable = (e) => {
      if (e.data.size > 0) orderTakerChunks.push(e.data);
    };
    customer.ondataavailable = (e) => {
      if (e.data.size > 0) customerChunks.push(e.data);
    };
    combined.start(1000);
    orderTaker.start(1000);
    customer.start(1000);
    return {
      combined,
      orderTaker,
      customer,
      combinedChunks,
      orderTakerChunks,
      customerChunks,
    };
  } catch (err) {
    console.error("[recording] Failed to start:", err);
    return null;
  }
}

async function stopAndUpload(
  recorders: Recorders,
  meta: {
    callId: string;
    orderTaker: string;
    branchId: string;
    customerName: string;
    customerPhone: string;
    customerAddress: string;
    duration: string;
    callStartedAt: number;
  },
  onProgress: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let stopped = 0;
    const checkDone = () => {
      stopped++;
      if (stopped >= 3) uploadBlobs().then(resolve);
    };
    recorders.combined.onstop = checkDone;
    recorders.orderTaker.onstop = checkDone;
    recorders.customer.onstop = checkDone;
    recorders.combined.stop();
    recorders.orderTaker.stop();
    recorders.customer.stop();
    async function uploadBlobs() {
      onProgress("Uploading recording...");
      try {
        const form = new FormData();
        form.append("callId", meta.callId);
        form.append("orderTaker", meta.orderTaker);
        form.append("branchId", meta.branchId);
        form.append("customerName", meta.customerName);
        form.append("customerPhone", meta.customerPhone);
        form.append("customerAddress", meta.customerAddress);
        form.append("duration", meta.duration);
        form.append("timestamp", new Date(meta.callStartedAt).toISOString());
        form.append(
          "combined",
          new Blob(recorders.combinedChunks, { type: "video/webm" }),
          "combined.webm",
        );
        form.append(
          "ordertaker",
          new Blob(recorders.orderTakerChunks, { type: "video/webm" }),
          "ordertaker.webm",
        );
        form.append(
          "customer",
          new Blob(recorders.customerChunks, { type: "audio/webm" }),
          "customer.webm",
        );
        await fetch("/api/recordings/upload", { method: "POST", body: form });
        onProgress("Recording saved ✓");
      } catch (err) {
        console.error("[recording] Upload failed:", err);
        onProgress("Upload failed");
      }
    }
  });
}

export default function OrderTaker() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [branchId, setBranchId] = useState("");
  const [loginError, setLoginError] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [screen, setScreen] = useState<
    "idle" | "incoming" | "call" | "uploading"
  >("idle");
  const [available, setAvailable] = useState(false);
  const [pendingPartnerId, setPendingPartnerId] = useState<string | null>(null);
  const [customerDetails, setCustomerDetails] =
    useState<CustomerDetails | null>(null);
  const [connected, setConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [facingMode, setFacingMode] = useState<"user" | "environment">(
    "environment",
  );
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [stats, setStats] = useState<{
    byBranch: Record<string, { waiting: number; inCall: number }>;
  } | null>(null);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [showRingtonePrompt, setShowRingtonePrompt] = useState(false);
  const [toast, setToast] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [previousCustomer, setPreviousCustomer] = useState<{
    name: string;
    phone?: string;
    address: string;
  } | null>(null);

  const socketRef = useRef<any>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const iceConfigRef = useRef<RTCConfiguration>({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const partnerIdRef = useRef<string | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const ringtoneRef = useRef<HTMLAudioElement>(null);
  const customerDetailsRef = useRef<CustomerDetails | null>(null);
  const recordersRef = useRef<Recorders | null>(null);
  const callIdRef = useRef<string | null>(null);
  const callStartedAtRef = useRef<number | null>(null);
  const userIdRef = useRef("");
  const branchIdRef = useRef("");
  const duration = useCallDuration(callStartedAt);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  useEffect(() => {
    branchIdRef.current = branchId;
  }, [branchId]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };
  const startRingtone = () => {
    ringtoneRef.current
      ?.play()
      .then(() => setShowRingtonePrompt(false))
      .catch(() => setShowRingtonePrompt(true));
  };
  const stopRingtone = () => {
    if (!ringtoneRef.current) return;
    ringtoneRef.current.pause();
    ringtoneRef.current.currentTime = 0;
    setShowRingtonePrompt(false);
  };

  const handleDisconnect = useCallback(async (stayAvailable = false) => {
    if (customerDetailsRef.current) {
      setPreviousCustomer({ ...customerDetailsRef.current });
      customerDetailsRef.current = null;
    }
    if (recordersRef.current) {
      const rec = recordersRef.current;
      recordersRef.current = null;
      setScreen("uploading");
      const sec = callStartedAtRef.current
        ? Math.floor((Date.now() - callStartedAtRef.current) / 1000)
        : 0;
      const dur = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
      const snap = {
        ...(customerDetailsRef.current || { name: "", phone: "", address: "" }),
      };
      await stopAndUpload(
        rec,
        {
          callId: callIdRef.current || "",
          orderTaker: userIdRef.current,
          branchId: branchIdRef.current,
          customerName: snap.name || "",
          customerPhone: (snap as any).phone || "",
          customerAddress: snap.address || "",
          duration: dur,
          callStartedAt: callStartedAtRef.current || Date.now(),
        },
        setUploadStatus,
      );
      setTimeout(() => setUploadStatus(""), 3000);
    }
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    localStreamRef.current = null;
    setConnected(false);
    setScreen("idle");
    setPendingPartnerId(null);
    setCustomerDetails(null);
    setIsMuted(false);
    setCameraOn(true);
    setCallStartedAt(null);
    callIdRef.current = null;
    callStartedAtRef.current = null;
    if (stayAvailable && socketRef.current) {
      socketRef.current.emit("order-taker-ready", {
        branchId: branchIdRef.current,
      });
      setAvailable(true);
    } else setAvailable(false);
  }, []);

  const startCall = useCallback(
    (partnerId: string) => {
      partnerIdRef.current = partnerId;
      const pc = new RTCPeerConnection(iceConfigRef.current);
      const remoteStream = new MediaStream();
      let recordingStarted = false;
      pc.onicecandidate = (e) => {
        if (e.candidate)
          socketRef.current?.emit("signal", {
            to: partnerId,
            signal: { ice: e.candidate },
          });
      };
      pc.ontrack = (e) => {
        e.streams[0].getTracks().forEach((tr) => remoteStream.addTrack(tr));
        if (audioRef.current) audioRef.current.srcObject = e.streams[0];
        if (localStreamRef.current && !recordingStarted) {
          recordingStarted = true;
          recordersRef.current = startRecording(
            localStreamRef.current,
            remoteStream,
          );
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setConnected(true);
          stopRingtone();
          pc.getSenders().forEach(async (s) => {
            if (s.track?.kind === "video") return
            const params = s.getParameters()
            if (!params.encodings) params.encodings = [{}];
            params.encodings[0].maxBitrate = 2500000;
            await s.setParameters(params);
          });
        }
        if (pc.connectionState === "disconnected") {
          // Wait 5 seconds — if it recovers, do nothing
          setTimeout(() => {
            if (pc.connectionState !== "connected") handleDisconnect(false)
          }, 5000)
        }
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          handleDisconnect(false)
        }
      };
      peerRef.current = pc;
      if (localStreamRef.current) {
        localStreamRef.current
          .getTracks()
          .forEach((tr) => pc.addTrack(tr, localStreamRef.current!));
        pc.createOffer().then((offer) =>
          pc.setLocalDescription(offer).then(() => {
            socketRef.current?.emit("signal", {
              to: partnerId,
              signal: { offer },
            });
          }),
        );
      }
    },
    [handleDisconnect],
  );

  useEffect(() => {
    const socket = io();
    socketRef.current = socket;
    socket.on("ice-config", (config: RTCConfiguration) => {
      iceConfigRef.current = config;
    });
    socket.on("branches", (list: Branch[]) => {
      setBranches(Array.isArray(list) ? list : []);
    });
    socket.on("stats", (s: any) => setStats(s));
    socket.on(
      "matched",
      (payload: {
        partnerId: string;
        customer?: { name?: string; address?: string; phone?: string };
      }) => {
        const c = payload?.customer || {};
        const details = {
          name: c.name || "",
          phone: c.phone || "",
          address: c.address || "",
        };
        setPendingPartnerId(payload?.partnerId || null);
        setCustomerDetails(details);
        customerDetailsRef.current = details;
        setScreen("incoming");
        startRingtone();
      },
    );
    socket.on("signal", async ({ signal }: { signal: any }) => {
      const pc = peerRef.current;
      if (!pc || pc.signalingState === "closed") return;
      if (signal.answer) await pc.setRemoteDescription(signal.answer);
      if (signal.ice) {
        try {
          await pc.addIceCandidate(signal.ice);
        } catch (_) {}
      }
    });
    socket.on(
      "call-started",
      ({
        callStartedAt,
        callId,
      }: {
        callStartedAt: number;
        callId: string;
      }) => {
        setCallStartedAt(callStartedAt);
        callIdRef.current = callId;
        callStartedAtRef.current = callStartedAt;
      },
    );
    socket.on("partner-disconnected", () => {
      stopRingtone();
      showToast(`${t.custDisconnected.en} / ${t.custDisconnected.ar}`);
      handleDisconnect(true);
    });
    return () => {
      socket.disconnect();
    };
  }, [startCall, handleDisconnect]);

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current)
      localVideoRef.current.srcObject = localStreamRef.current;
  });

  const ensureLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  };

  const acceptCall = async () => {
    if (!pendingPartnerId) return;
    stopRingtone();
    await ensureLocalStream();
    socketRef.current?.emit("call-accepted", { to: pendingPartnerId });
    setScreen("call");
    startCall(pendingPartnerId);
    setPendingPartnerId(null);
  };

  const declineCall = () => {
    stopRingtone();
    socketRef.current?.emit("end-call");
    setPendingPartnerId(null);
    setCustomerDetails(null);
    setScreen("idle");
    if (branchId) {
      socketRef.current?.emit("order-taker-ready", { branchId });
      setAvailable(true);
    }
  };

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    const next = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((tr) => {
      tr.enabled = !next;
    });
    setIsMuted(next);
  };

  const toggleCamera = () => {
    if (!localStreamRef.current) return;
    const next = !cameraOn;
    localStreamRef.current.getVideoTracks().forEach((tr) => {
      tr.enabled = next;
    });
    setCameraOn(next);
  };

  const switchCamera = async () => {
    if (!localStreamRef.current) return;
    const newMode = facingMode === "environment" ? "user" : "environment";
    try {
      localStreamRef.current.getVideoTracks().forEach((tr) => tr.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newMode },
        audio: false,
      });
      const videoTrack = stream.getVideoTracks()[0];
      if (peerRef.current && connected) {
        const sender = peerRef.current
          .getSenders()
          .find((s: RTCRtpSender) => s.track?.kind === "video");
        if (sender) await sender.replaceTrack(videoTrack);
      }
      localStreamRef.current = new MediaStream([
        videoTrack,
        ...localStreamRef.current.getAudioTracks(),
      ]);
      setFacingMode(newMode);
      setLocalStream(localStreamRef.current);
    } catch (err) {
      console.error("[media] switchCamera failed:", err);
    }
  };

  const endCall = () => {
    socketRef.current?.emit("end-call");
    stopRingtone();
    handleDisconnect(false);
  };

  const doLogin = () => {
    setLoginError("");
    if (!branchId) {
      setLoginError(`${t.selectBranchErr.en} / ${t.selectBranchErr.ar}`);
      return;
    }
    socketRef.current?.emit(
      "login",
      { userId, password, role: "order_taker", branchId },
      (res: any) => {
        if (!res?.ok) {
          setLoginError(res?.error || "Login failed");
          return;
        }
        setLoggedIn(true);
      },
    );
  };

  const branchLabel = branches.find((b) => b.id === branchId)?.name || "Branch";

  if (screen === "uploading") {
    return (
      <main>
        <div className="card" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⏳</div>
          <div className="card-title" style={{ marginBottom: 8 }}>
            {t.savingRec.en}
            <br />
            <span className="ar">{t.savingRec.ar}</span>
          </div>
          <p style={{ fontSize: 14, opacity: 0.75 }}>
            {uploadStatus || t.pleaseWait.en}
            <br />
            <span className="ar">{t.pleaseWait.ar}</span>
          </p>
          <p style={{ fontSize: 12, opacity: 0.5, marginTop: 12 }}>
            {t.dontClose.en}
            <br />
            <span className="ar">{t.dontClose.ar}</span>
          </p>
        </div>
      </main>
    );
  }

  if (screen === "call") {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#000" }}>
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <audio ref={audioRef} autoPlay />
        <div className="rec-badge">⏺ REC</div>
        {duration && <div className="call-timer-pill">⏱ {duration}</div>}
        {customerDetails && (
          <div className="customer-pill">
            <span>👤</span>
            <span className="pill-name">{customerDetails.name || "—"}</span>
            {customerDetails.phone && (
              <>
                <span className="pill-dot">·</span>
                <span className="pill-address">☎️ {customerDetails.phone}</span>
              </>
            )}
            {customerDetails.address && (
              <>
                <span className="pill-dot">·</span>
                <span className="pill-address">
                  📍 {customerDetails.address}
                </span>
              </>
            )}
          </div>
        )}
        <div className="call-controls">
          <button
            className={`call-btn${isMuted ? " active" : ""}`}
            onClick={toggleMute}
          >
            <span className="btn-icon">{isMuted ? "🔇" : "🎤"}</span>
            <span>{isMuted ? t.unmute.en : t.mute.en}</span>
            <span className="ar">{isMuted ? t.unmute.ar : t.mute.ar}</span>
          </button>
          <button
            className={`call-btn${!cameraOn ? " active" : ""}`}
            onClick={toggleCamera}
          >
            <span className="btn-icon">📹</span>
            <span>{cameraOn ? t.camOff.en : t.camOn.en}</span>
            <span className="ar">{cameraOn ? t.camOff.ar : t.camOn.ar}</span>
          </button>
          <button className="call-btn" onClick={switchCamera}>
            <span className="btn-icon">🔄</span>
            <span>{t.flip.en}</span>
            <span className="ar">{t.flip.ar}</span>
          </button>
          <button
            className="call-btn danger"
            style={{ marginLeft: 8 }}
            onClick={endCall}
          >
            <span className="btn-icon">✕</span>
            <span>{t.end.en}</span>
            <span className="ar">{t.end.ar}</span>
          </button>
        </div>
        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  return (
    <main>
      <audio ref={ringtoneRef} src="/ringtone.mp3" loop />
      {toast && <div className="toast">{toast}</div>}
      {showRingtonePrompt && (
        <button
          className="btn-ghost"
          style={{
            position: "fixed",
            top: 20,
            right: 20,
            width: "auto",
            padding: "10px 16px",
            zIndex: 100,
          }}
          onClick={startRingtone}
        >
          {t.enableRingtone.en} /{" "}
          <span className="ar">{t.enableRingtone.ar}</span>
        </button>
      )}

      <h1 style={{ textAlign: "center" }}>
        <div>{t.title.en}</div>
        <div className="ar" style={{ fontSize: 20, marginTop: 4 }}>
          {t.title.ar}
        </div>
      </h1>

      {!loggedIn && (
        <div className="card">
          <div className="card-title">
            {t.signIn.en} / <span className="ar">{t.signIn.ar}</span>
          </div>
          <div className="card-subtitle">
            {t.signInSub.en}
            <br />
            <span className="ar">{t.signInSub.ar}</span>
          </div>
          <div className="field">
            <label>
              {t.employeeId.en} / <span className="ar">{t.employeeId.ar}</span>
            </label>
            <input
              placeholder={`${t.idPlaceholder.en} / ${t.idPlaceholder.ar}`}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
            />
          </div>
          <div className="field">
            <label>
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
          <div className="field">
            <label>
              {t.branch.en} / <span className="ar">{t.branch.ar}</span>
            </label>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">
                {t.selectBranch.en} / {t.selectBranch.ar}
              </option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <button onClick={doLogin}>
            <div>{t.login.en}</div>
            <div className="ar">{t.login.ar}</div>
          </button>
          {loginError && <div className="error-text">{loginError}</div>}
        </div>
      )}

      {loggedIn && screen === "idle" && (
        <div className="card">
          <div className="card-title">{branchLabel}</div>
          <div className="card-subtitle">{userId}</div>
          {stats && branchId && (
            <div className="stats-row">
              <div className="stat-box">
                <div className="stat-num">
                  {stats.byBranch?.[branchId]?.waiting ?? 0}
                </div>
                <div className="stat-label">
                  {t.waiting2.en} / <span className="ar">{t.waiting2.ar}</span>
                </div>
              </div>
              <div className="stat-box">
                <div className="stat-num">
                  {stats.byBranch?.[branchId]?.inCall ?? 0}
                </div>
                <div className="stat-label">
                  {t.inCall.en} / <span className="ar">{t.inCall.ar}</span>
                </div>
              </div>
            </div>
          )}
          {previousCustomer && (
            <div className="customer-detail-card" style={{ marginBottom: 16 }}>
              <div className="detail-label">
                {t.prevCustomer.en} /{" "}
                <span className="ar">{t.prevCustomer.ar}</span>
              </div>
              <div className="detail-name" style={{ fontSize: 16 }}>
                {previousCustomer.name}
              </div>
              <div className="detail-divider" />
              <div className="detail-address">
                📍 {previousCustomer.address || "—"}
              </div>
              <div className="detail-address" style={{ marginTop: 4 }}>
                ☎️ {previousCustomer.phone || "—"}
              </div>
            </div>
          )}

          {!available ? (
            <button
              className="btn-green"
              onClick={() => {
                socketRef.current?.emit("order-taker-ready", { branchId });
                setAvailable(true);
              }}
            >
              <div>{t.goAvailable.en}</div>
              <div className="ar">{t.goAvailable.ar}</div>
            </button>
          ) : (
            <>
              <p
                style={{
                  marginBottom: 16,
                  padding: 12,
                  background: "rgba(255,255,255,0.08)",
                  borderRadius: 10,
                }}
              >
                {t.waiting.en}
                <br />
                <span className="ar">{t.waiting.ar}</span>
              </p>
              <button
                className="btn-ghost"
                onClick={() => {
                  socketRef.current?.emit("order-taker-not-available");
                  setAvailable(false);
                }}
              >
                <div>{t.goOffline.en}</div>
                <div className="ar">{t.goOffline.ar}</div>
              </button>
            </>
          )}
        </div>
      )}

      {loggedIn && screen === "incoming" && customerDetails && (
        <div className="card">
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div className="pulse-ring ring-animation">📞</div>
            <div className="card-title">
              {t.incomingOrder.en} /{" "}
              <span className="ar">{t.incomingOrder.ar}</span>
            </div>
          </div>
          <div className="customer-detail-card">
            <div className="detail-label">
              {t.customer.en} / <span className="ar">{t.customer.ar}</span>
            </div>
            <div className="detail-name">{customerDetails.name || "—"}</div>
            <div className="detail-divider" />
            <div className="detail-label">
              {t.phoneNum.en} / <span className="ar">{t.phoneNum.ar}</span>
            </div>
            <div className="detail-phone">
              ☎️ {customerDetails.phone || "—"}
            </div>
            <div className="detail-divider" />
            <div className="detail-label">
              {t.deliveryAddr.en} /{" "}
              <span className="ar">{t.deliveryAddr.ar}</span>
            </div>
            <div className="detail-address">
              📍 {customerDetails.address || "—"}
            </div>
          </div>
          <button className="btn-green" onClick={acceptCall}>
            <div>{t.acceptCall.en}</div>
            <div className="ar">{t.acceptCall.ar}</div>
          </button>
          <button className="btn-red" onClick={declineCall}>
            <div>{t.decline.en}</div>
            <div className="ar">{t.decline.ar}</div>
          </button>
        </div>
      )}
    </main>
  );
}
