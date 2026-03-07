"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import io from "socket.io-client";

type Branch = { id: string; name: string; lat: number; lng: number };

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
    </main>
  );
}
