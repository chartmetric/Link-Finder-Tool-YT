// Preload for offline CLI tests. Block operations, not harmless imports.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw Error('Network forbidden during offline YouTube evidence preparation.');};
globalThis.fetch=blocked;
for(const mod of [http,https])for(const key of ['request','get'])mod[key]=blocked;
for(const key of ['connect','createConnection'])net[key]=blocked;
net.Socket.prototype.connect=blocked;
tls.connect=blocked;
dgram.createSocket=blocked;
for(const key of ['lookup','resolve','resolve4','resolve6','reverse']){
  dns[key]=blocked;
  if(key in dns.promises)dns.promises[key]=blocked;
}
syncBuiltinESMExports();
