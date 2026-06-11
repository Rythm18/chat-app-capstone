import type { NodeStatus } from "../../../shared/decoder";

/** Instrument light: gray=queued, pulsing amber=running, amber=waiting on
 *  user, green=completed, red=failed. */
export function StatusDot({ status }: { status: NodeStatus }) {
  return <span className={`dot dot-${status}`} aria-label={status} />;
}
