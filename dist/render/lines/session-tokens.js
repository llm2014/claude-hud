import { label } from '../colors.js';
import { t } from '../../i18n/index.js';
function formatTokens(n) {
    if (n >= 1000000) {
        return `${(n / 1000000).toFixed(1)}M`;
    }
    if (n >= 1000) {
        return `${(n / 1000).toFixed(0)}k`;
    }
    return n.toString();
}
export function renderSessionTokensLine(ctx) {
    const display = ctx.config?.display;
    if (display?.showSessionTokens === false && display?.showAllTokens !== true) {
        return null;
    }
    const tokens = ctx.transcript.sessionTokens;
    if (!tokens) {
        return null;
    }
    const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
    if (total === 0) {
        return null;
    }
    const colors = ctx.config?.colors;
    const parts = [];
    const showAllTokens = display?.showAllTokens === true;
    parts.push(`${t('format.in')}: ${formatTokens(tokens.inputTokens)}`);
    parts.push(`${t('format.out')}: ${formatTokens(tokens.outputTokens)}`);
    if (showAllTokens) {
        parts.push(`${t('format.cacheRead')}: ${formatTokens(tokens.cacheReadTokens)}`);
        parts.push(`${t('format.cacheWrite')}: ${formatTokens(tokens.cacheCreationTokens)}`);
    }
    else if (tokens.cacheCreationTokens > 0 || tokens.cacheReadTokens > 0) {
        parts.push(`${t('format.cache')}: ${formatTokens(tokens.cacheCreationTokens + tokens.cacheReadTokens)}`);
    }
    return label(`${t('label.tokens')} ${formatTokens(total)} (${parts.join(', ')})`, colors);
}
export function renderAllSessionTokensLine(ctx) {
    const display = ctx.config?.display;
    if (display?.showAllTokens !== true) {
        return null;
    }
    const tokens = ctx.transcript.sessionTokens;
    if (!tokens) {
        return null;
    }
    const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
    if (total === 0) {
        return null;
    }
    const colors = ctx.config?.colors;
    const callCount = ctx.transcript.assistantCount ?? 0;
    return label(`${t('label.tokens')} ${formatTokens(total)} (${t('format.in')}: ${formatTokens(tokens.inputTokens)}, ${t('format.out')}: ${formatTokens(tokens.outputTokens)}, ${t('format.cacheRead')}: ${formatTokens(tokens.cacheReadTokens)}, ${t('format.cacheWrite')}: ${formatTokens(tokens.cacheCreationTokens)}, ${callCount} ${t('format.calls')})`, colors);
}
//# sourceMappingURL=session-tokens.js.map