import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import Gate, { type NativeLifecycle } from "../modules/jit-native-gate";
import type { MobileSession } from "../../../src/s16/mobile/session";

/** Native visibility fences synchronously precede React state; only a current public root's layout can uncover. */
export function useLifecycle(session: MutableRefObject<MobileSession | null>) {
  const [native, setNative] = useState<NativeLifecycle>({ epoch: 0, active: false }), current = useRef(native);
  const [uncovered, setUncovered] = useState(0), [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const receive = (value: NativeLifecycle) => {
      if (!live) return;
      if (!value || !Number.isSafeInteger(value.epoch) || value.epoch < 1 || typeof value.active !== "boolean") { session.current?.background(); setFailure("mobile_lifecycle_invalid"); return; }
      if (value.epoch <= current.current.epoch) return;
      // restore() fences immediately before its first await. A native event never grants server authority.
      if (value.active) void session.current?.restore().catch(() => {}); else session.current?.background();
      current.current = value; setNative(value); setFailure(null);
    };
    const subscription = Gate.addListener("lifecycle", receive);
    void Gate.status().then(receive, () => { if (live) { session.current?.background(); setFailure("mobile_lifecycle_unavailable"); } });
    return () => { live = false; subscription.remove(); session.current?.background(); };
  }, [session]);
  const acknowledge = useCallback((epoch: number, generation: number, owner: MobileSession | null) => {
    if (!current.current.active || current.current.epoch !== epoch || session.current !== owner || owner && owner.projection.generation !== generation) return;
    void Gate.acknowledge(epoch).then(ok => {
      if (ok && current.current.active && current.current.epoch === epoch && session.current === owner && (!owner || owner.projection.generation === generation)) setUncovered(epoch);
    }, () => { session.current?.background(); setFailure("mobile_lifecycle_unavailable"); });
  }, [session]);
  return { native, current, ready: native.active && uncovered === native.epoch && !failure, failure, acknowledge };
}
