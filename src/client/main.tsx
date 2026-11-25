import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import './schedule.css'
import './views.css'

class BoardErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[agy-board] render error:', error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 16,
            fontFamily: 'system-ui, sans-serif',
            fontSize: 13,
            color: 'var(--agy-danger-fg, #b91c1c)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {`Agy Board render error:\n${this.state.error.stack || this.state.error.message}`}
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BoardErrorBoundary>
      <App />
    </BoardErrorBoundary>
  </StrictMode>,
)
