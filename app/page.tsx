"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import io from "socket.io-client";

type Branch = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  whatsapp?: string;
};

function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function findClosestBranch(
  loc: { lat: number; lng: number },
  branches: Branch[],
) {
  if (!branches.length) return null;
  return branches.reduce((best, b) =>
    haversineKm(loc, b) < haversineKm(loc, best) ? b : best,
  );
}

export default function CustomerPage() {
  const [screen, setScreen] = useState<"form" | "queue" | "waiting" | "call">(
    "form",
  );
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState("auto");
  const [showWhatsapp, setShowWhatsapp] = useState(false);
  const [waBranch, setWaBranch] = useState("");
  const [tooltipDismissed, setTooltipDismissed] = useState(false);
  const [userLocation, setUserLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [locationStatus, setLocationStatus] = useState<
    "idle" | "detecting" | "found" | "denied"
  >("idle");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [queuePosition, setQueuePosition] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [joining, setJoining] = useState(false);
  const [toast, setToast] = useState("");

  const socketRef = useRef<any>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const iceConfigRef = useRef<RTCConfiguration>({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const partnerIdRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  // Auto-detect location on mount
  useEffect(() => {
    if (!navigator.geolocation) return;
    setLocationStatus("detecting");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        setLocationStatus("found");
      },
      () => setLocationStatus("denied"),
      { timeout: 8000 },
    );
  }, []);

  // Auto-select closest branch when both location and branches are ready
  useEffect(() => {
    if (!userLocation || !branches.length || selectedBranchId !== "auto")
      return;
    const closest = findClosestBranch(userLocation, branches);
    if (closest) setSelectedBranchId(closest.id);
  }, [userLocation, branches]);

  const startCall = useCallback((partnerId: string) => {
    partnerIdRef.current = partnerId;
    const pc = new RTCPeerConnection(iceConfigRef.current);

    pc.onicecandidate = (e) => {
      if (e.candidate)
        socketRef.current?.emit("signal", {
          to: partnerId,
          signal: { ice: e.candidate },
        });
    };
    pc.ontrack = (e) => {
      if (videoRef.current) videoRef.current.srcObject = e.streams[0];
    };
    peerRef.current = pc;
  }, []);

  useEffect(() => {
    const socket = io();
    socketRef.current = socket;

    socket.on("ice-config", (config: RTCConfiguration) => {
      iceConfigRef.current = config;
    });
    socket.on("branches", (list: Branch[]) => {
      setBranches(Array.isArray(list) ? list : []);
    });
    socket.on("queue-position", (pos: number) => {
      setQueuePosition(pos);
    });
    socket.on("matched", () => {
      setScreen("waiting");
    });
    socket.on("call-accepted", (partnerId: string) => {
      setScreen("call");
      startCall(partnerId);
    });
    socket.on("signal", async ({ signal }: { signal: any }) => {
      const pc = peerRef.current;
      if (!pc || pc.signalingState === "closed") return;
      if (signal.offer) {
        await pc.setRemoteDescription(signal.offer);
        audioStreamRef.current
          ?.getTracks()
          .forEach((t) => pc.addTrack(t, audioStreamRef.current!));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current?.emit("signal", {
          to: partnerIdRef.current,
          signal: { answer },
        });
      }
      if (signal.answer) await pc.setRemoteDescription(signal.answer);
      if (signal.ice) {
        try {
          await pc.addIceCandidate(signal.ice);
        } catch (_) {}
      }
    });
    socket.on("partner-disconnected", () => {
      cleanup();
      showToast("Order taker disconnected");
      setScreen("form");
    });
    return () => {
      socket.disconnect();
    };
  }, [startCall]);

  const cleanup = () => {
    peerRef.current?.close();
    peerRef.current = null;
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;
    setIsMuted(false);
    setJoining(false);
  };

  const joinQueue = async () => {
    if (joining || !customerName.trim() || !customerAddress.trim()) return;
    let branchId = selectedBranchId;
    if (branchId === "auto") {
      const closest = userLocation
        ? findClosestBranch(userLocation, branches)
        : null;
      branchId = closest?.id || branches[0]?.id || "";
    }
    if (!branchId) {
      showToast("Please select a branch");
      return;
    }
    setJoining(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      audioStreamRef.current = stream;
      socketRef.current?.emit("join-queue", {
        branchId,
        name: customerName.trim(),
        address: customerAddress.trim(),
        phone: customerPhone.trim(),
      });
      setScreen("queue");
    } catch {
      showToast("Microphone access is required to place an order");
    } finally {
      setJoining(false);
    }
  };

  const leaveQueue = () => {
    cleanup();
    window.location.reload();
  };

  const toggleMute = () => {
    if (!audioStreamRef.current) return;
    const next = !isMuted;
    audioStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setIsMuted(next);
  };

  const endCall = () => {
    socketRef.current?.emit("end-call");
    cleanup();
    setScreen("form");
  };

  // ── Call screen ────────────────────────────────────────────────────────────
  if (screen === "call") {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#000" }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />

        <div className="call-controls">
          <button
            className={`call-btn${isMuted ? " active" : ""}`}
            onClick={toggleMute}
          >
            <span className="btn-icon">{isMuted ? "🔇" : "🎤"}</span>
            {isMuted ? "Unmute" : "Mute"}
          </button>
          <button className="call-btn danger" onClick={endCall}>
            <span className="btn-icon">✕</span>
            End Call
          </button>
        </div>

        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  // ── Card screens ───────────────────────────────────────────────────────────
  return (
    <main>
      {toast && <div className="toast">{toast}</div>}
      <h1>🛒 Supermarket Ordering</h1>

      {/* Form */}
      {screen === "form" && (
        <div className="card">
          <div className="field">
            <label>
              Branch
              {locationStatus === "detecting" && (
                <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 400 }}>
                  {" "}
                  · detecting...
                </span>
              )}
              {locationStatus === "found" && (
                <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 400 }}>
                  {" "}
                  · closest selected
                </span>
              )}
            </label>
            <select
              value={selectedBranchId}
              onChange={(e) => setSelectedBranchId(e.target.value)}
            >
              <option value="auto">📍 Auto (closest)</option>
              {branches.map((b) => {
                const dist = userLocation ? haversineKm(userLocation, b) : null;
                return (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {dist !== null ? ` · ${dist.toFixed(1)} km` : ""}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="field">
            <label>Your Name</label>
            <input
              placeholder="e.g. Ahmed Hassan"
              autoComplete="name"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinQueue()}
            />
          </div>

          <div className="field">
            <label>Phone Number</label>
            <input
              placeholder="e.g. 01012345678"
              autoComplete="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinQueue()}
            />
          </div>

          <div className="field">
            <label>Delivery Address</label>
            <input
              placeholder="e.g. 12 Nile St, Cairo"
              autoComplete="street-address"
              value={customerAddress}
              onChange={(e) => setCustomerAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinQueue()}
            />
          </div>

          <button
            onClick={joinQueue}
            disabled={
              joining ||
              !customerName.trim() ||
              !customerAddress.trim() ||
              !customerPhone.trim()
            }
          >
            {joining ? "Connecting..." : "Place Call"}
          </button>
        </div>
      )}

      {/* Queue */}
      {screen === "queue" && (
        <div className="card" style={{ textAlign: "center" }}>
          <p>⏳ You're in the queue</p>
          <div className="queue-position">{queuePosition}</div>
          <p style={{ marginBottom: 32 }}>
            {queuePosition === 0
              ? "You're next!"
              : `${queuePosition === 1 ? "person" : "people"} ahead of you`}
          </p>
          <button className="btn-ghost" onClick={leaveQueue}>
            Leave Queue
          </button>
        </div>
      )}

      {/* Waiting */}
      {screen === "waiting" && (
        <div className="card" style={{ textAlign: "center" }}>
          <div className="pulse-ring">📞</div>
          <p style={{ fontSize: 18, marginBottom: 8 }}>
            Ringing order taker...
          </p>
          <p style={{ fontSize: 14, opacity: 0.7, marginBottom: 28 }}>
            Please wait, someone will answer shortly
          </p>
          <button className="btn-ghost" onClick={leaveQueue}>
            Cancel
          </button>
        </div>
      )}

      {/* WhatsApp Tooltip */}
      {!tooltipDismissed && !showWhatsapp && (
        <div
          className="whatsapp-tooltip"
          onClick={() => setTooltipDismissed(true)}
        >
          💬 Need to change your order or ask a question?
        </div>
      )}

      {/* WhatsApp branch selector panel */}
      {showWhatsapp && (
        <div className="wa-panel">
          <button className="wa-close" onClick={() => setShowWhatsapp(false)}>
            ✕
          </button>
          <div className="wa-panel-title">💬 WhatsApp Us</div>
          <div className="wa-panel-sub">Select your branch to start a chat</div>
          <select
            value={waBranch}
            onChange={(e) => setWaBranch(e.target.value)}
          >
            <option value="">Select branch...</option>
            {branches
              .filter((b) => b.whatsapp)
              .map((b) => (
                <option key={b.id} value={b.whatsapp!}>
                  {b.name}
                </option>
              ))}
          </select>
          <button
            className="wa-text-btn"
            disabled={!waBranch}
            onClick={() => {
              window.open(`https://wa.me/${waBranch}`, "_blank");
              setShowWhatsapp(false);
            }}
          >
            Open WhatsApp →
          </button>
        </div>
      )}

      {/* WhatsApp floating button */}
      <button
        className="wa-bubble"
        onClick={() => {
          setShowWhatsapp(!showWhatsapp);
          setTooltipDismissed(true);
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="white"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
        </svg>
      </button>
    </main>
  );
}
