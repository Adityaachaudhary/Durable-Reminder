import type { ItemDetail, ItemView } from './service';

export function formatRow(item: ItemView): string {
  const when = `${item.scheduledLocal} [${item.timeZone}]`;
  const retry = item.nextAttemptAt ? `  retry at ${item.nextAttemptAt}` : '';
  const reason = item.terminalReason ? `  (${item.terminalReason})` : '';
  return `${item.id.padEnd(14)} v${item.version}  ${item.state.padEnd(9)} ${when}${retry}${reason}  "${item.content}"`;
}

/** Human-readable inspection: current version, how the time was interpreted, attempts and version history. */
export function formatDetail(item: ItemDetail): string {
  const lines: string[] = [];
  lines.push(`${item.id}   ${item.kind}${item.conversationId ? ` (conversation ${item.conversationId})` : ''}`);
  lines.push(`  state:        ${item.state}${item.terminalReason ? ` (${item.terminalReason})` : ''}`);
  lines.push(`  version:      ${item.version}   delivery key: ${item.deliveryKey}`);
  lines.push(`  content:      "${item.content}"`);
  lines.push(`  requested:    ${item.requestedLocalTime} in ${item.timeZone}`);
  lines.push(`  runs at:      ${item.scheduledAt} (UTC) = ${item.scheduledLocal} local   [${item.timeResolution}]`);
  if (item.nextAttemptAt) lines.push(`  next attempt: ${item.nextAttemptAt}`);
  lines.push(item.attempts.length === 0 ? '  attempts:     (none)' : '  attempts:');
  for (const a of item.attempts) {
    const late = a.latenessMs > 0 ? `  late by ${a.latenessMs} ms` : '';
    lines.push(`    #${a.seq} v${a.version} try ${a.occurrenceAttempt}  ${a.claimedAt}  ${a.workerId}  -> ${a.outcome}${late}${a.detail ? `  (${a.detail})` : ''}`);
  }
  lines.push(`  versions:`);
  for (const r of item.revisions) {
    lines.push(`    v${r.version}  ${r.scheduledAt}  "${r.content}"  ${r.supersededAt ? `superseded at ${r.supersededAt}` : '(current)'}`);
  }
  return lines.join('\n');
}
