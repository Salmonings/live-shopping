import { useEffect, useState } from "react"

export function useCallDuration(callStartedAt: number | null): string {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!callStartedAt) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [callStartedAt])

  if (!callStartedAt) return ""
  const elapsed = Math.floor((Date.now() - callStartedAt) / 1000)
  const h = Math.floor(elapsed / 3600)
  const m = Math.floor((elapsed % 3600) / 60)
  const s = elapsed % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
  return `${m}:${s.toString().padStart(2, "0")}`
}
