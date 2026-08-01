"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { Modal } from "./Modal";
import { Skel } from "./shared";

interface FileData {
  name: string;
  path: string;
  size: number;
  viewable: boolean;
  downloadable: boolean;
  fromRepoFallback: boolean;
  reason?: "too-large" | "binary";
  content?: string;
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function FileViewer({ taskId, path, onClose }: { taskId: string; path: string; onClose: () => void }) {
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error`: a failed download must not blank out file contents
  // that already loaded fine.
  const [dlError, setDlError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const preRef = useRef<HTMLPreElement>(null);

  const src = `/api/tasks/${taskId}/file?path=${encodeURIComponent(path)}`;

  // Plain fetch, not the jget helper: fail() throws only `error` and discards
  // `reason`, which the states below switch on.
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    // Reset the per-file UI state too, or opening a second file without closing
    // the modal carries the previous file's download error and "Copied" flash.
    setDlError(null);
    setCopied("");
    fetch(src)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok) setData(j as FileData);
        else setError(j.error || "File is no longer available.");
      })
      .catch(() => { if (live) setError("File is no longer available."); });
    return () => { live = false; };
  }, [src]);

  // Unlike the other clipboard call sites in this app, a failure must NOT be
  // swallowed: navigator.clipboard is undefined outside a secure context, and
  // copying is the whole point of this modal. Fall back to selecting the text.
  const copy = async () => {
    if (!data?.content) return;
    try {
      await navigator.clipboard.writeText(data.content);
      setCopied("ok");
      setTimeout(() => setCopied(""), 1400);
    } catch {
      const pre = preRef.current;
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCopied("fail");
    }
  };

  // A button rather than an anchor: if the file vanished between opening the
  // modal and clicking, an anchor navigates the browser to an error page.
  const download = async () => {
    setDlError(null);
    try {
      const r = await fetch(`${src}&download=1`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setDlError(j.error || "File is too large to download.");
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = data?.name || "file";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDlError("Download failed.");
    }
  };

  // Ordered so the states are mutually exclusive: a file over DOWNLOAD_MAX is
  // both "too-large" and undownloadable, and the download verdict wins.
  const body = () => {
    if (error) return <div className="hlp">{error}</div>;
    if (!data) return <Skel w="100%" h={140} />;
    if (!data.downloadable)
      return <div className="hlp">This file is {fmtSize(data.size)} — too large to show or download from here. Use the project terminal.</div>;
    if (!data.viewable && data.reason === "too-large")
      return <div className="hlp">This file is {fmtSize(data.size)} — too large to show here. Download it instead.</div>;
    if (!data.viewable) return <div className="hlp">This looks like a binary file. Download it instead.</div>;
    return <pre ref={preRef} className="tool-pre" style={{ maxHeight: "60vh", overflow: "auto" }}>{data.content}</pre>;
  };

  const copyLabel = copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed — text selected, press Ctrl/Cmd+C" : "Copy";

  return (
    <Modal
      title={data?.name ?? path.split("/").slice(-1)[0]}
      sub={data?.fromRepoFallback ? "This task's workspace was cleaned up — showing the repository's copy." : path}
      onClose={onClose}
      width={760}
      footer={
        <>
          {data?.viewable && !error && (
            <button className="btn btn-line" onClick={copy}>
              {copied === "ok" ? Icon.check() : Icon.copy()} {copyLabel}
            </button>
          )}
          {data && !error && (
            <button className="btn btn-line" onClick={download} disabled={!data.downloadable}>
              {Icon.doc()} Download
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </>
      }
    >
      {body()}
      {dlError && <div className="hlp" style={{ marginTop: 8 }}>{dlError}</div>}
    </Modal>
  );
}
