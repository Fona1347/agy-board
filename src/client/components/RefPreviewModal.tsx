import { useState } from 'react'
import { Copy, ExternalLink, MessageSquarePlus, X } from 'lucide-react'
import { getSidecar } from '../api.ts'
import { tr, type Locale } from '../i18n.ts'
import { fsPathToFileUri, isSafeExternalUrl } from '../utils.ts'

export interface PreviewData {
  ok?: boolean
  refId?: string
  kind?: string
  target?: string
  resolvedPath?: string
  isUrl?: boolean
  isBinary?: boolean
  language?: string
  sizeBytes?: number
  truncated?: boolean
  content?: string
  message?: string
}

export function RefPreviewModal({
  locale,
  preview,
  onClose,
  onToast,
}: {
  locale: Locale
  preview: PreviewData
  onClose: () => void
  onToast: (msg: string) => void
}) {
  const [commentText, setCommentText] = useState('')
  const sidecar = getSidecar()
  const isFileLike = Boolean(
    preview.resolvedPath &&
      !preview.isUrl &&
      preview.kind !== 'url' &&
      preview.kind !== 'command' &&
      !preview.message &&
      preview.ok !== false,
  )
  const canComment = Boolean(sidecar?.ui?.addArtifactComment && isFileLike)
  const fileUri = preview.resolvedPath && isFileLike ? fsPathToFileUri(preview.resolvedPath) : undefined

  const handleCopy = async () => {
    const val = preview.resolvedPath || preview.target || ''
    try {
      await navigator.clipboard.writeText(val)
      onToast(`Copied ${val}`)
    } catch {
      onToast(val)
    }
  }

  const handleSendComment = () => {
    if (!commentText.trim() || !sidecar?.ui?.addArtifactComment || !fileUri) return
    sidecar.ui.addArtifactComment({
      uri: fileUri,
      comment: commentText.trim(),
      pageTitle: preview.target,
    })
    setCommentText('')
    onToast('Sent artifact comment to Antigravity composer')
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-box"
        style={{ width: 'min(680px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        data-testid="ref-preview-modal"
      >
        <div className="drawer-header">
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 13, wordBreak: 'break-word' }}>{preview.target}</strong>
            <div className="card-meta-line">
              {preview.kind} · {preview.language ?? 'text'} · {preview.sizeBytes ?? 0} bytes
              {preview.truncated ? ' (truncated to 256 KiB)' : ''}
            </div>
          </div>
          <div className="row-wrap">
            {sidecar?.ui?.toggleAuxPane && fileUri && (
              <button
                type="button"
                className="btn btn-xs"
                onClick={() => {
                  sidecar.ui?.toggleAuxPane?.({ tabType: 'fileView', uri: fileUri })
                }}
              >
                <ExternalLink size={11} />
                <span>{tr(locale, 'openInAuxFileView')}</span>
              </button>
            )}
            {preview.isUrl && preview.target && isSafeExternalUrl(preview.target) && (
              <a
                className="btn btn-xs"
                href={preview.target}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={11} />
                <span>{tr(locale, 'openUrl')}</span>
              </a>
            )}
            <button type="button" className="btn btn-xs" onClick={handleCopy}>
              <Copy size={11} />
              <span>Copy</span>
            </button>
            <button type="button" className="btn btn-xs" onClick={onClose} aria-label={tr(locale, 'close')}>
              <X size={13} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          {preview.message || preview.ok === false ? (
            <div className="badge badge-warn">{preview.message || 'Preview unavailable'}</div>
          ) : (
            <pre className="code-preview">{preview.content ?? ''}</pre>
          )}

          {canComment && (
            <div className="row-wrap">
              <input
                className="input-field"
                style={{ flex: 1 }}
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Add read-only artifact comment for next message..."
              />
              <button
                type="button"
                className="btn btn-xs btn-primary"
                disabled={!commentText.trim()}
                onClick={handleSendComment}
              >
                <MessageSquarePlus size={12} />
                <span>{tr(locale, 'commentToAgent')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
