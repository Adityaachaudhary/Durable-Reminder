import { runBenchmark } from './runBenchmark';

const report = await runBenchmark();

console.log('Durable reminders: workflow-correctness benchmark');
console.log(`items: ${report.items}   zones: ${report.zones.join(', ')}   passes: 2`);
console.log(`service stopped and restarted; ${report.overdueAtRestart} item(s) were already overdue at restart`);
console.log('');
console.log('group                    items  final state(s)   violations');
for (const row of report.perGroup) {
  console.log(`${row.group.padEnd(24)} ${String(row.items).padEnd(6)} ${row.finalStates.padEnd(16)} ${row.violations}`);
}
console.log('');
console.log('terminal-state counts: ' + Object.entries(report.countsByState).map(([state, n]) => `${state}=${n}`).join('  '));
console.log(`delivered items: ${report.deliveredItems}   logical notifications at the destination: ${report.logicalNotifications}   delivery records: ${report.deliveryRecords}`);
console.log(
  `duplicate execution (d-1): destination asked ${report.duplicateExecution.sendCalls} times -> ` +
    `${report.duplicateExecution.logicalNotifications} logical notification, ${report.duplicateExecution.deliveryRecords} delivery record`,
);
console.log('checked per item: final state and attempt history as expected | exactly 1 notification per delivered occurrence |');
console.log('                  0 for cancelled/failed and for superseded versions | never delivered early | no unresolved attempts');
console.log(`repeatable (2 passes, digests ${report.digests[0]} / ${report.digests[1]}): ${report.repeatable ? 'yes' : 'NO'}`);
if (report.violations.length > 0) {
  console.log('');
  for (const violation of report.violations.slice(0, 25)) console.log('VIOLATION ' + violation);
}
console.log('');
console.log(report.passed ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(report.passed ? 0 : 1);
