import { lookup as systemLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Agent } from 'undici';

interface RunningHubNetworkConfig {
  origin?: string;
  connectIp?: string;
  localInterface?: string;
}

/** Override only this platform's connection, keeping URL, Host, SNI and TLS verification intact. */
export function createRunningHubTransport(config: RunningHubNetworkConfig = {
  origin: process.env.RUNNINGHUB_BASE_URL,
  connectIp: process.env.RUNNINGHUB_CONNECT_IP,
  localInterface: process.env.RUNNINGHUB_LOCAL_INTERFACE,
}) {
  const connectIp = config.connectIp?.trim();
  const localInterface = config.localInterface?.trim();
  if (!connectIp) {
    if (localInterface) throw new Error('RUNNINGHUB_LOCAL_INTERFACE requires RUNNINGHUB_CONNECT_IP');
    return { fetch: globalThis.fetch, close: async () => {} };
  }
  const family = isIP(connectIp);
  if (!family) throw new Error('RUNNINGHUB_CONNECT_IP must be an IPv4 or IPv6 address');
  const target = new URL(config.origin || 'https://www.runninghub.ai');
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password ||
    target.pathname !== '/' || target.search || target.hash || isIP(target.hostname))
    throw new Error('RunningHub network origin must contain a hostname, without credentials or a path');

  // Resolve the current interface address at worker startup instead of persisting a DHCP address.
  const localAddress = localInterface ? networkInterfaces()[localInterface]?.find(address =>
    address.family === (family === 4 ? 'IPv4' : 'IPv6'))?.address : undefined;
  if (localInterface && !localAddress)
    throw new Error('RUNNINGHUB_LOCAL_INTERFACE has no address matching RUNNINGHUB_CONNECT_IP');

  const lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname !== target.hostname) { systemLookup(hostname, options, callback); return; }
    if (options.all) callback(null, [{ address: connectIp, family }]);
    else callback(null, connectIp, family);
  };
  const dispatcher = new Agent({ localAddress, connect: { lookup } });
  const platformFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== target.origin) return globalThis.fetch(input, init);
    // No retry wrapper: a lost create response must never replay a paid submission.
    return globalThis.fetch(input, { ...init, dispatcher, redirect: 'error' } as RequestInit & { dispatcher: Agent });
  };
  return { fetch: platformFetch, close: () => dispatcher.close() };
}
