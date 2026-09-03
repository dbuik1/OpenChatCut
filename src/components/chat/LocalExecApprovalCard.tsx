import { useCallback, useSyncExternalStore } from 'react';
import { localExecApprovalGate } from '../../agent/local-exec-approval';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { Icon } from '../icons';
import { ApprovalDetails } from './ApprovalDetails';

/**
 * Per-call confirmation for the tools that put third-party code on this
 * machine and run it. There is deliberately no "always allow": the decision
 * belongs to one repository or one command, shown verbatim below.
 */
export function LocalExecApprovalCard() {
  const t = useT();
  const subscribe = useCallback(
    (listener: () => void) => localExecApprovalGate.subscribe(listener),
    [],
  );
  const pending = useSyncExternalStore(
    subscribe,
    () => localExecApprovalGate.pending(),
    () => null,
  );
  if (!pending) return null;
  return (
    <div
      role="alertdialog"
      style={{
        margin: '10px 0', padding: '10px 12px', borderRadius: 6,
        background: theme.panelAlt, border: `0.5px solid ${theme.danger}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        <Icon name="wand" size={14} />
        <strong style={{ fontSize: 12.5 }}>
          {pending.tool === 'install_skill'
            ? t('安装第三方技能仓库到本机')
            : pending.tool === 'run_skill_script'
              ? t('在本机执行技能脚本')
              : t('在本机执行代码')}
        </strong>
      </div>
      <div style={{ fontSize: 12, color: theme.text, marginBottom: 8, lineHeight: 1.5 }}>
        {t('工具 {tool} 将在你的电脑上运行本项目之外的代码。确认只对下面这一次调用生效，没有「始终允许」。', {
          tool: pending.tool,
        })}
        <ApprovalDetails details={pending.details} argsDigest={pending.argsDigest} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => localExecApprovalGate.resolve(pending.id, true)}
          style={{ border: `0.5px solid ${theme.danger}`, background: 'none', color: theme.text, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}
        >
          {t('本次运行')}
        </button>
        <button
          type="button"
          onClick={() => localExecApprovalGate.resolve(pending.id, false)}
          style={{ border: `0.5px solid ${theme.border}`, background: 'none', color: theme.textDim, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}
        >
          {t('拒绝')}
        </button>
      </div>
    </div>
  );
}
