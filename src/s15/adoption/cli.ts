import { readInstallerAdoptionReport } from '../../../ops/package/installer/adoption';
import { AppError } from '../../errors';

/** Explicit report-only CLI. Mutations require the authenticated protected host API, never a plan file. */
export function runAdoptionReport(args: string[]): void {
  try {
    const report = readInstallerAdoptionReport(args[4]!);
    console.log(JSON.stringify(report));
    if (report.refusals.length) process.exitCode = 2;
  } catch (error) {
    const code = error instanceof AppError && error.message.startsWith('transition_') ? error.message : 'transition_report_refused';
    console.log(JSON.stringify({ contract: 's15-state-transition/v1', state: 'refused', reason: code })); process.exitCode = 2;
  }
}
