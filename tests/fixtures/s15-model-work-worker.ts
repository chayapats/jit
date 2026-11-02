import { openWorkService } from '../../src/s15/work';
import { openModelService } from '../../src/s15/model';
import { modelWorkFixture, observed } from './s15-model-work';

const [mode, root] = process.argv.slice(2);
if (!root || !['active', 'wait', 'model'].includes(mode!)) throw Error('invalid_fixture_mode');
const f = modelWorkFixture({ root, create: true }), source = f.source('source');
if (mode === 'model') {
  const service = openModelService({ ...f.modelOptions(), scripted: route => ({ provider: 'codex-subscription', id: route.modelId, async *stream() {
    console.log(JSON.stringify({ workId: source.authority!.id }));
    await new Promise<void>(() => { setInterval(() => {}, 60000); });
    yield { type: 'message_complete', message: { type: 'assistant', id: 'never', content: [] } };
  } }) });
  await service.runStep(source.actor!, { stepId: 'step', difficulty: 'ordinary', text: 'Selected issue only.', ownerDecisions: [], sources: [] });
} else {
  const service = openWorkService(f.workOptions());
  const r = service.assign(f.owner, { requestId: 'assign', sourceRequestId: 'source', completion: 'Checks pass.', triggers: ['ci'], stallPolicy: { noProgressApproaches: 3, reserveCalls: 1, maxAttempts: 8 } });
  const handle = service.beginAttempt(r.id, { eventId: 'source', approach: 'Original operation' });
  if (mode === 'wait') {
    service.settle(handle, observed({ progress: 'made' }));
    service.wait(r.id, { requestId: 'wait', kind: 'ci', key: 'head_1', evidenceRefs: ['head_evidence'] });
  }
  console.log(JSON.stringify({ responsibilityId: r.id, workId: source.authority!.id }));
  await new Promise<void>(() => { setInterval(() => {}, 60000); });
}
