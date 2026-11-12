import {registerHooks, syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';

const forbidden = () => {throw Error('Network forbidden in preparation fixtures.');};
globalThis.fetch = forbidden;
net.Socket.prototype.connect = net.Server.prototype.listen = forbidden;
tls.connect = http.request = http.get = https.request = https.get = forbidden;
dns.lookup = dns.resolve = dnsPromises.lookup = dnsPromises.resolve = forbidden;
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^pg(?:\/|$)/.test(specifier)) throw Error('Live database forbidden in preparation fixtures.');
    return nextResolve(specifier, context);
  },
});
