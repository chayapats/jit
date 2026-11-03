import { adoptionOptions } from './s15-adoption';
import { openAdoptionService, type AdoptionCheckpoint, type AdoptionCommand } from '../../src/s15/adoption';

const input = JSON.parse(await Bun.stdin.text()) as { root: string; installationId: string; point: AdoptionCheckpoint | null; command: AdoptionCommand | null };
const options = adoptionOptions(input.root, input.installationId);
options.fault = point => { if (point === input.point) process.kill(process.pid, 'SIGKILL'); };
const service = openAdoptionService(options);
try {
  if (input.command) console.log(JSON.stringify(service.command(service.authenticate('owner_session'), input.command)));
  else { service.guardActivity(); console.log('activity_returned'); }
}
finally { service.close(); }
