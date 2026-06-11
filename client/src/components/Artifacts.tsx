import { useEffect, useState } from "react";
import type { Artifact, Run } from "../../../shared/decoder";
import { nodeLabel } from "../../../shared/decoder";
import type { Session } from "../useSession";
import { Markdown } from "./Markdown";
import { bytes } from "../format";

/** Artifact chips for a run; clicking one opens the viewer overlay. */
export function ArtifactChips({ run, session }: { run: Run; session: Session }) {
  const [open, setOpen] = useState<Artifact | null>(null);
  if (run.artifacts.length === 0) return null;

  return (
    <div className="artifact-section">
      <span className="microlabel">ARTIFACTS · {run.artifacts.length}</span>
      <div className="artifact-chips">
        {run.artifacts.map((a) => {
          const author = run.nodes[a.agentId];
          return (
            <button key={a.path} className="artifact-chip" onClick={() => setOpen(a)}>
              <span className="artifact-icon">▤</span>
              <span className="artifact-name">{a.name}</span>
              <span className="artifact-meta">
                {bytes(a.sizeBytes)}
                {author ? ` · ${nodeLabel(run, author)}` : ""}
              </span>
            </button>
          );
        })}
      </div>
      {open && <ArtifactViewer artifact={open} session={session} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ArtifactViewer({
  artifact,
  session,
  onClose,
}: {
  artifact: Artifact;
  session: Session;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(session.artifactUrl(artifact.path))
      .then(async (res) => {
        if (!res.ok) throw new Error(`fetch failed (${res.status})`);
        return res.text();
      })
      .then((text) => !cancelled && setContent(text))
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [artifact.path, session]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="viewer-title">{artifact.path}</span>
          <button className="viewer-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="viewer-body">
          {error && <div className="error-line">{error}</div>}
          {content === null && !error && <div className="viewer-loading">loading…</div>}
          {content !== null &&
            (artifact.name.endsWith(".md") ? (
              <Markdown text={content} />
            ) : (
              <pre className="viewer-pre">{content}</pre>
            ))}
        </div>
      </div>
    </div>
  );
}
