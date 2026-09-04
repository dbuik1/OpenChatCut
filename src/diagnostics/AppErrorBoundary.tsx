import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n/locale';
import { reportRenderError } from './rendererErrorReporting';
import { describeRendererError } from './describeRendererError';

interface Props { readonly children: ReactNode }
interface State { readonly message: string | null }

/** A render-time throw unmounts the whole React tree; without this the user
 *  is left on a blank window with no way to recover or to find out what
 *  happened. The fallback names both next actions: reload, and where the
 *  record went. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: describeRendererError(error).message };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportRenderError(error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    const desktop = typeof window !== 'undefined' ? window.openChatCutDesktop?.diagnostics : undefined;
    return (
      <div className="cc-app-crash" role="alert">
        <div className="cc-app-crash-title">{t('界面出错了')}</div>
        <div className="cc-app-crash-detail">{this.state.message}</div>
        <div className="cc-app-crash-hint">
          {desktop ? t('已记录到日志文件夹。工程最近一次保存的版本不受影响。') : t('工程最近一次保存的版本不受影响。')}
        </div>
        <div className="cc-app-crash-actions">
          <button type="button" className="cc-app-crash-primary" onClick={() => window.location.reload()}>
            {t('重新加载')}
          </button>
          {desktop && (
            <button type="button" onClick={() => { void desktop.openLogFolder().catch(() => {}); }}>
              {t('打开日志文件夹')}
            </button>
          )}
        </div>
      </div>
    );
  }
}
