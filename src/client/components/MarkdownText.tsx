import { Fragment, type ReactNode } from 'react'

function isSafeLinkHref(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('#') || (trimmed.startsWith('/') && !trimmed.startsWith('//'))) {
    return true
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}

function renderInlineFormatting(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let idx = 0
  let tokenIndex = 0

  // Tokenize inline code, links, bold, and italic without catastrophic backtracking
  const pattern =
    /(`[^`\n]+`)|(\[([^\]\n]+)\]\(([^)\s]+)\))|(\*\*([^*\n]+)\*\*)|(__([^_\n]+)__)|(\*([^*\n]+)\*)|((?:^|(?<=[\s(]))_([^_\n]+)_)/g

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > idx) {
      nodes.push(text.slice(idx, start))
    }

    const k = `${keyPrefix}-${tokenIndex++}`
    if (match[1]) {
      nodes.push(
        <code key={k} className="md-inline-code">
          {match[1].slice(1, -1)}
        </code>,
      )
    } else if (match[2]) {
      const label = match[3]
      const href = match[4]
      if (isSafeLinkHref(href)) {
        nodes.push(
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="md-link">
            {label}
          </a>,
        )
      } else {
        nodes.push(`${label} (${href})`)
      }
    } else if (match[5]) {
      nodes.push(<strong key={k}>{renderInlineFormatting(match[6], `${k}-b`)}</strong>)
    } else if (match[7]) {
      nodes.push(<strong key={k}>{renderInlineFormatting(match[8], `${k}-bu`)}</strong>)
    } else if (match[9]) {
      nodes.push(<em key={k}>{renderInlineFormatting(match[10], `${k}-i`)}</em>)
    } else if (match[11]) {
      nodes.push(<em key={k}>{renderInlineFormatting(match[12], `${k}-iu`)}</em>)
    }

    idx = start + match[0].length
  }

  if (idx < text.length) {
    nodes.push(text.slice(idx))
  }
  return nodes
}

export function MarkdownText({
  content,
  className = '',
}: {
  content: string
  className?: string
}) {
  if (!content.trim()) return null

  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let blockKey = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim()
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push(
        <pre key={`b-${blockKey++}`} className="md-code-block" data-lang={lang || undefined}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`b-${blockKey++}`} className="md-hr" />)
      i += 1
      continue
    }

    // Heading (# .. ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const body = renderInlineFormatting(headingMatch[2], `h-${blockKey}`)
      const key = `b-${blockKey++}`
      if (level === 1) blocks.push(<h1 key={key} className="md-h1">{body}</h1>)
      else if (level === 2) blocks.push(<h2 key={key} className="md-h2">{body}</h2>)
      else if (level === 3) blocks.push(<h3 key={key} className="md-h3">{body}</h3>)
      else blocks.push(<h4 key={key} className="md-h4">{body}</h4>)
      i += 1
      continue
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push(
        <blockquote key={`b-${blockKey++}`} className="md-quote">
          {quoteLines.map((ql, qi) => (
            <Fragment key={qi}>
              {qi > 0 && <br />}
              {renderInlineFormatting(ql, `q-${blockKey}-${qi}`)}
            </Fragment>
          ))}
        </blockquote>,
      )
      continue
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i += 1
      }
      const key = `b-${blockKey++}`
      blocks.push(
        <ul key={key} className="md-list">
          {items.map((item, li) => (
            <li key={li}>{renderInlineFormatting(item, `${key}-${li}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i += 1
      }
      const key = `b-${blockKey++}`
      blocks.push(
        <ol key={key} className="md-list">
          {items.map((item, li) => (
            <li key={li}>{renderInlineFormatting(item, `${key}-${li}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // Paragraph (collect consecutive non-special lines)
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('```') &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i += 1
    }
    const key = `b-${blockKey++}`
    blocks.push(
      <p key={key} className="md-p">
        {paraLines.map((pl, pi) => (
          <Fragment key={pi}>
            {pi > 0 && <br />}
            {renderInlineFormatting(pl, `${key}-${pi}`)}
          </Fragment>
        ))}
      </p>,
    )
  }

  return <div className={`markdown-body${className ? ` ${className}` : ''}`}>{blocks}</div>
}
