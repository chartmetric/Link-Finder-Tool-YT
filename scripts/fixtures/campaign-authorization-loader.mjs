// Run the real one-time authorization CLI without importing pg or any transport.
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

const gate = new URL('../src/instagram-saved-batch-gate.mjs', import.meta.url).href;
const helper = new URL('./campaign-memory-ledger.mjs', import.meta.url).href;
const forbidden = () => { throw Error('Network forbidden in campaign fixtures.'); };
globalThis.fetch = forbidden;
net.Socket.prototype.connect = forbidden;
net.Server.prototype.listen = forbidden;
tls.connect = forbidden;
http.request = http.get = https.request = https.get = forbidden;
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^pg(?:\/|$)/.test(specifier))
      throw Error('Database module forbidden in campaign fixtures: ' + specifier);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === gate) return {format: 'module', shortCircuit: true,
      source: `export {connectFixturePool as connectSavedBatchPool} from ${JSON.stringify(helper)};`};
    return nextLoad(url, context);
  },
});
