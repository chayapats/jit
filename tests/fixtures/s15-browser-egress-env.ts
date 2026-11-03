import { connect } from 'node:net';
import { openBrowserEgress } from '../../src/s15/browser/egress';
import { fixturePublicAddress } from './s15-browser';

// Child process for BROW15-03: the parent sets proxy environment variables; one broker route must still reach
// only its checked address. `.invalid` never resolves, so any direct or proxied path would fail.
const port = Number(process.argv[2]), dials: string[] = [];
const egress = openBrowserEgress({ resolve: async () => [{ address: fixturePublicAddress, family: 4 }], connect: (address, target) => { dials.push(address); return connect({ host: '127.0.0.1', port: target }); } });
try {
  const url = `http://env-check.invalid:${port}/env`, route = await egress.route(url);
  const response = await route.fetch(url, { method: 'GET' }), body = await response.text(); route.close();
  console.log(JSON.stringify({ status: response.status, body: body.includes('reached') ? 'reached' : 'other', dials }));
} catch (error) { console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'failed', dials })); }
finally { egress.close(); }
