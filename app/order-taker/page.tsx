"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import { useCallDuration } from "../useCallDuration";

type Branch = { id: string; name: string };
type CustomerDetails = { name: string; phone?: string; address: string };
type PreviousCustomer = { name: string; address: string } | null;


// ── Recording helpers ──────────────────────────────────────────────────────────

function getMimeType(): string {
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  return types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm'
}

interface Recorders {
  combined: MediaRecorder
  orderTaker: MediaRecorder
  customer: MediaRecorder
  combinedChunks: Blob[]
  orderTakerChunks: Blob[]
  customerChunks: Blob[]
}

function startRecording(localStream: MediaStream, remoteStream: MediaStream): Recorders | null {
  try {
    const mimeType = getMimeType()
    const ctx = new AudioContext()
    const localSrc = ctx.createMediaStreamSource(localStream)
    const remoteSrc = ctx.createMediaStreamSource(remoteStream)
    const dest = ctx.createMediaStreamDestination()
    localSrc.connect(dest)
    remoteSrc.connect(dest)
    const combinedStream = new MediaStream([...localStream.getVideoTracks(), ...dest.stream.getAudioTracks()])
    const orderTakerStream = new MediaStream([...localStream.getVideoTracks(), ...localStream.getAudioTracks()])
    const customerStream = new MediaStream([...remoteStream.getAudioTracks()])
    const combinedChunks: Blob[] = []
    const orderTakerChunks: Blob[] = []
    const customerChunks: Blob[] = []
    const combined = new MediaRecorder(combinedStream, { mimeType })
    const orderTaker = new MediaRecorder(orderTakerStream, { mimeType })
    const customer = new MediaRecorder(customerStream, { mimeType: 'audio/webm' })
    combined.ondataavailable = e => { if (e.data.size > 0) combinedChunks.push(e.data) }
    orderTaker.ondataavailable = e => { if (e.data.size > 0) orderTakerChunks.push(e.data) }
    customer.ondataavailable = e => { if (e.data.size > 0) customerChunks.push(e.data) }
    combined.start(1000)
    orderTaker.start(1000)
    customer.start(1000)
    return { combined, orderTaker, customer, combinedChunks, orderTakerChunks, customerChunks }
  } catch (err) {
    console.error('[recording] Failed to start:', err)
    return null
  }
}

async function stopAndUpload(
  recorders: Recorders,
  meta: { callId: string; orderTaker: string; branchId: string; customerName: string; customerPhone: string; customerAddress: string; duration: string; callStartedAt: number },
  onProgress: (msg: string) => void
): Promise<void> {
  return new Promise(resolve => {
    let stopped = 0
    const checkDone = () => { stopped++; if (stopped >= 3) uploadBlobs().then(resolve) }
    recorders.combined.onstop = checkDone
    recorders.orderTaker.onstop = checkDone
    recorders.customer.onstop = checkDone
    recorders.combined.stop()
    recorders.orderTaker.stop()
    recorders.customer.stop()
    async function uploadBlobs() {
      onProgress('Uploading recording...')
      try {
        const form = new FormData()
        form.append('callId', meta.callId)
        form.append('orderTaker', meta.orderTaker)
        form.append('branchId', meta.branchId)
        form.append('customerName', meta.customerName)
        form.append('customerPhone', meta.customerPhone)
        form.append('customerAddress', meta.customerAddress)
        form.append('duration', meta.duration)
        form.append('timestamp', new Date(meta.callStartedAt).toISOString())
        form.append('combined', new Blob(recorders.combinedChunks, { type: 'video/webm' }), 'combined.webm')
        form.append('ordertaker', new Blob(recorders.orderTakerChunks, { type: 'video/webm' }), 'ordertaker.webm')
        form.append('customer', new Blob(recorders.customerChunks, { type: 'audio/webm' }), 'customer.webm')
        await fetch('/api/recordings/upload', { method: 'POST', body: form })
        onProgress('Recording saved ✓')
      } catch (err) {
        console.error('[recording] Upload failed:', err)
        onProgress('Upload failed')
      }
    }
  })
}

export default function OrderTaker() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [branchId, setBranchId] = useState("");
  const [loginError, setLoginError] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [screen, setScreen] = useState<"idle" | "incoming" | "call" | "uploading">("idle");
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

  // Keep refs in sync with state for use inside async callbacks
  useEffect(() => { userIdRef.current = userId }, [userId])
  useEffect(() => { branchIdRef.current = branchId }, [branchId])

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

  const handleDisconnect = useCallback(
    async (stayAvailable = false) => {
      // Save previous customer before clearing
      if (customerDetailsRef.current) {
        customerDetailsRef.current = null;
      }

      // Stop recording and upload
      if (recordersRef.current) {
        const rec = recordersRef.current;
        recordersRef.current = null;
        setScreen("uploading");
        const sec = callStartedAtRef.current ? Math.floor((Date.now() - callStartedAtRef.current) / 1000) : 0;
        const dur = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        const snap = { ...(customerDetailsRef.current || { name: "", phone: "", address: "" }) };
        await stopAndUpload(rec, {
          callId: callIdRef.current || "",
          orderTaker: userIdRef.current,
          branchId: branchIdRef.current,
          customerName: snap.name || "",
          customerPhone: snap.phone || "",
          customerAddress: snap.address || "",
          duration: dur,
          callStartedAt: callStartedAtRef.current || Date.now(),
        }, setUploadStatus);
        setTimeout(() => setUploadStatus(""), 3000);
      }

      peerRef.current?.close();
      peerRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
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
        socketRef.current.emit("order-taker-ready", { branchId: branchIdRef.current });
        setAvailable(true);
      } else {
        setAvailable(false);
      }
    },
    [],
  );

  const startCall = useCallback(
    (partnerId: string) => {
      partnerIdRef.current = partnerId;
      const pc = new RTCPeerConnection(iceConfigRef.current);
      pc.onicecandidate = (e) => {
        if (e.candidate)
          socketRef.current?.emit("signal", {
            to: partnerId,
            signal: { ice: e.candidate },
          });
      };
      const remoteStream = new MediaStream();
      let recordingStarted = false;
      pc.ontrack = (e) => {
        e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
        if (audioRef.current) audioRef.current.srcObject = e.streams[0];
        if (localStreamRef.current && !recordingStarted) {
          recordingStarted = true;
          recordersRef.current = startRecording(localStreamRef.current, remoteStream);
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setConnected(true);
          stopRingtone();
        }
        if (["disconnected", "failed", "closed"].includes(pc.connectionState))
          handleDisconnect(false);
      };
      peerRef.current = pc;
      if (localStreamRef.current) {
        localStreamRef.current
          .getTracks()
          .forEach((t) => pc.addTrack(t, localStreamRef.current!));
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
        setPendingPartnerId(payload?.partnerId || null);
        setCustomerDetails({
          name: c.name || "",
          phone: c.phone || "",
          address: c.address || "",
        });
        customerDetailsRef.current = {
          name: c.name || "",
          phone: c.phone || "",
          address: c.address || "",
        };
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
    socket.on("call-started", ({ callStartedAt, callId }: { callStartedAt: number; callId: string }) => {
      setCallStartedAt(callStartedAt);
      callIdRef.current = callId;
      callStartedAtRef.current = callStartedAt;
    });
    socket.on("partner-disconnected", () => {
      stopRingtone();
      showToast("Customer disconnected");
      handleDisconnect(true);
    });
    return () => {
      socket.disconnect();
    };
  }, [startCall, handleDisconnect]);

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  });

  const ensureLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode },
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
    localStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setIsMuted(next);
  };

  const toggleCamera = () => {
    if (!localStreamRef.current) return;
    const next = !cameraOn;
    localStreamRef.current.getVideoTracks().forEach((t) => {
      t.enabled = next;
    });
    setCameraOn(next);
  };

  const switchCamera = async () => {
    if (!localStreamRef.current) return;
    const newMode = facingMode === "environment" ? "user" : "environment";
    try {
      localStreamRef.current.getVideoTracks().forEach((t) => t.stop());
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
      setLoginError("Please select a branch");
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

  // ── Uploading screen ────────────────────────────────────────────────────────
  if (screen === "uploading") {
    return (
      <main>
        <div className="card" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⏳</div>
          <div className="card-title" style={{ marginBottom: 8 }}>Saving Recording</div>
          <p style={{ fontSize: 14, opacity: 0.75 }}>{uploadStatus || "Please wait..."}</p>
          <p style={{ fontSize: 12, opacity: 0.5, marginTop: 12 }}>Do not close this tab</p>
        </div>
      </main>
    );
  }

    // ── Call screen ────────────────────────────────────────────────────────────
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

        {customerDetails && (
          <div className="customer-pill">
            <span>👤</span>
            <span className="pill-name">{customerDetails.name || "—"}</span>
            {customerDetails.phone && (
              <>
                <span className="pill-dot">·</span>
                <span className="pill-phone">☎️ {customerDetails.phone}</span>
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
            {duration && (
              <div className="call-timer-pill">
                ⏱ {duration}
              </div>
            )}
          </div>
        )}

        <div className="call-controls">
          <button
            className={`call-btn${isMuted ? " active" : ""}`}
            onClick={toggleMute}
          >
            <span className="btn-icon">{isMuted ? "🔇" : "🎤"}</span>
            {isMuted ? "Unmute" : "Mute"}
          </button>
          <button
            className={`call-btn${!cameraOn ? " active" : ""}`}
            onClick={toggleCamera}
          >
            <span className="btn-icon">📹</span>
            {cameraOn ? "Cam Off" : "Cam On"}
          </button>
          <button className="call-btn" onClick={switchCamera}>
            <span className="btn-icon">🔄</span>
            Flip
          </button>
          <button
            className="call-btn danger"
            style={{ marginLeft: 8 }}
            onClick={endCall}
          >
            <span className="btn-icon">✕</span>
            End
          </button>
        </div>

        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  // ── Card screens ───────────────────────────────────────────────────────────
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
          🔔 Enable Ringtone
        </button>
      )}

      <h1>📹 Order Taker</h1>

      {/* Login */}
      {!loggedIn && (
        <div className="card">
          <div className="card-title">Sign In</div>
          <div className="card-subtitle">Log in to start taking orders</div>
          <div className="field">
            <label>Employee ID</label>
            <input
              placeholder="e.g. ahmed"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
            />
          </div>
          <div className="field">
            <label>Branch</label>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">Select your branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <button onClick={doLogin}>Login</button>
          {loginError && <div className="error-text">{loginError}</div>}
        </div>
      )}

      {/* Idle */}
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
                <div className="stat-label">Waiting</div>
              </div>
              <div className="stat-box">
                <div className="stat-num">
                  {stats.byBranch?.[branchId]?.inCall ?? 0}
                </div>
                <div className="stat-label">In Call</div>
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
              🟢 Go Available
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
                ⏳ Waiting for a customer...
              </p>
              <button
                className="btn-ghost"
                onClick={() => {
                  socketRef.current?.emit("order-taker-not-available");
                  setAvailable(false);
                }}
              >
                ⛔ Go Offline
              </button>
            </>
          )}
        </div>
      )}

      {/* Incoming call */}
      {loggedIn && screen === "incoming" && customerDetails && (
        <div className="card">
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div className="pulse-ring ring-animation">📞</div>
            <div className="card-title">Incoming Order</div>
          </div>

          <div className="customer-detail-card">
            <div className="detail-label">Customer</div>
            <div className="detail-name">{customerDetails.name || "—"}</div>
            <div className="detail-divider" />
            <div className="detail-label">Phone Number</div>
            <div className="detail-phone">
              ☎️ {customerDetails.phone || "—"}
            </div>
            <div className="detail-divider" />
            <div className="detail-label">Delivery Address</div>
            <div className="detail-address">
              📍 {customerDetails.address || "—"}
            </div>
          </div>

          <button className="btn-green" onClick={acceptCall}>
            ✓ Accept Call
          </button>
          <button className="btn-red" onClick={declineCall}>
            ✕ Decline
          </button>
        </div>
      )}
    </main>
  );
}
