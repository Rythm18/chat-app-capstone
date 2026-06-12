import { useEffect, useState } from "react";
import type { Artifact, Run } from "../../../shared/decoder";
import { nodeLabel } from "../../../shared/decoder";
import type { Session } from "../useSession";
import { Markdown } from "./Markdown";
import { bytes } from "../format";

/** The run's headline deliverable: the report the report-writer saved.
 *  Rendered inline in the chat rather than pointed at by path. */
export function reportArtifact(run: Run): Artifact | null {
  return (
    run.artifacts.find(
      (a) => /(^|\/)reports?\//i.test(a.path) || /^report.*\.md$/i.test(a.name),
    ) ?? null
  );
}

/** Inline reader for the final brief: fetched on completion, rendered as
 *  markdown in a capped scroll box, expandable to the full overlay. */
export function ReportPanel({ run, session }: { run: Run; session: Session }) {
  const artifact = reportArtifact(run);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const path = artifact?.path;
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    fetch(session.artifactUrl(path))
      .then(async (res) => {
        if (!res.ok) throw new Error(`fetch failed (${res.status})`);
        return res.text();
      })
      .then((text) => !cancelled && setContent(text))
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [path, session]);

  if (!artifact) return null;

  return (
    <div className="report-panel">
      <div className="report-head">
        <span className="microlabel">FULL BRIEF · {artifact.name}</span>
        <button className="report-expand" onClick={() => setExpanded(true)}>
          ⤢ EXPAND
        </button>
      </div>
      <div className="report-body">
        {error && <div className="error-line">{error}</div>}
        {content === null && !error && <div className="viewer-loading">loading brief…</div>}
        {content !== null && <Markdown text={content} />}
      </div>
      {expanded && (
        <ArtifactViewer artifact={artifact} session={session} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
}

/** Artifact chips for a run; clicking one opens the viewer overlay. The
 *  report itself is excluded — it gets the inline ReportPanel instead. */
export function ArtifactChips({ run, session }: { run: Run; session: Session }) {
  const [open, setOpen] = useState<Artifact | null>(null);
  const hero = reportArtifact(run);
  const chips = run.artifacts.filter((a) => a.path !== hero?.path);
  if (chips.length === 0) return null;

  return (
    <div className="artifact-section">
      <span className="microlabel">ARTIFACTS · {chips.length}</span>
      <div className="artifact-chips">
        {chips.map((a) => {
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

export function ArtifactViewer({
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
