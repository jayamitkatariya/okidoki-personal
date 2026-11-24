/**
 * AEAD-2022 rather than the 2018 aes-256-gcm family: it adds replay protection
 * and resists the active-probing attacks that identify a Shadowsocks endpoint,
 * which matters because the exit ports are necessarily open to the Internet.
 *
 * The key is 32 raw bytes, base64-encoded. A 2018-style passphrase is rejected
 * at config load rather than silently downgraded, so a missed rotation fails
 * closed.
 */
export const EGRESS_CIPHER = '2022-blake3-aes-256-gcm';

export const EGRESS_KEY_BYTES = 32;

/** Both ends must agree: a TCP-only server silently breaks DNS and QUIC for a client expecting UDP relay. */
export const EGRESS_SHADOWSOCKS_MODE = 'tcp_and_udp';

/** Every IPv4 address: the one destination a full tunnel routes, and what sandboxes created for one deny directly, which is how a resume recognizes them. */
export const EGRESS_ALL_IPV4 = '0.0.0.0/0';

/**
 * Pinned because this binary carries a workspace's entire Internet traffic: a
 * moved release tag must not change what runs on either end of the tunnel.
 */
export const EGRESS_SHADOWSOCKS_VERSION = '1.24.0';
export const EGRESS_SHADOWSOCKS_SHA256 = '0d84f5f350ec99396867d718f146fc3810975b2a7cd06192f158d96bdef460e7';

/** One port per customer. AWS ingress, the exit's firewall, and credential allocation all derive from this. */
export const EGRESS_PORT_RANGE_START = 8400;
export const EGRESS_PORT_RANGE_END = 8499;

/**
 * Ordered fallbacks for the exit-IP check. A blocked socket can still look
 * connected from inside a sandbox, so verification always reads an
 * application response rather than trusting the connection.
 */
export const EGRESS_EXIT_IP_ENDPOINTS = [
  'https://checkip.amazonaws.com',
  'https://api.ipify.org',
  'https://icanhazip.com',
];

/**
 * Networks kept on the sandbox's own default route. Tunnelling these would
 * break Docker bridges and provider-internal addressing without gaining
 * anything: private space is not reachable from the exit anyway.
 */
export const EGRESS_DIRECT_ROUTES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
];

/**
 * Deliberately generous. These bound catastrophic abuse — a flood or a host
 * scan launched through the exit from a compromised workspace — rather than
 * shaping normal traffic, because a workspace running installs or a browser
 * legitimately opens connections in bursts. The counters they sit alongside are
 * the abuse signal; the drops are the backstop. Tune from observed load.
 */
export const EGRESS_NEW_CONN_RATE = 100;
export const EGRESS_NEW_CONN_BURST = 200;
export const EGRESS_UDP_RATE = 500;
export const EGRESS_UDP_BURST = 1000;
export const EGRESS_OUT_CONN_RATE = 1000;
export const EGRESS_OUT_CONN_BURST = 2000;

/**
 * The exit binds one outbound UDP socket per client session and every DNS
 * lookup from a workspace is its own session, so each lookup holds one of the
 * host's ~28k ephemeral ports until the session idles out. The upstream default
 * of five minutes let a hundred awake workspaces drain the range within three
 * minutes of every restart, failing all DNS through the exit with EADDRINUSE.
 * A lookup completes in milliseconds, so thirty seconds is generous.
 *
 * The timeout is what bounds the host: the range holds unless lookups arrive
 * faster than roughly 900/s across every listener. The cap does not help there,
 * because it is per listener and several customers can sum past the range. It
 * bounds one listener's association map (64 KiB receive buffer each) so a
 * single runaway customer evicts its own oldest idle sessions rather than
 * growing without limit, and it is memory protection, not a port budget.
 */
export const EGRESS_UDP_TIMEOUT_SECONDS = 30;
export const EGRESS_UDP_MAX_ASSOCIATIONS = 20_000;

/**
 * Both ends resolve here. In the workspace they are the tunnel-side resolver,
 * so name lookups exit from the static IP too. On the exit they are what the
 * server itself resolves with, because its own egress rules deny the service
 * user every private destination, which is where a VPC or stub resolver lives.
 */
export const EGRESS_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

/**
 * Rendered by `services/egress-proxy/deploy.sh` into the exit host's
 * `/opt/okidoki/egress-config.env`, and substituted into `Dockerfile.sandbox` by
 * the template publish script. Keeping the shell and the workspace client on
 * one definition is what stops the exit server and the tunnel it terminates
 * from drifting onto different builds or ciphers.
 */
export const EGRESS_SHELL_CONFIG = [
  `EGRESS_PORT_RANGE_START=${EGRESS_PORT_RANGE_START}`,
  `EGRESS_PORT_RANGE_END=${EGRESS_PORT_RANGE_END}`,
  `EGRESS_SHADOWSOCKS_VERSION=${EGRESS_SHADOWSOCKS_VERSION}`,
  `EGRESS_SHADOWSOCKS_SHA256=${EGRESS_SHADOWSOCKS_SHA256}`,
  `EGRESS_CIPHER=${EGRESS_CIPHER}`,
  `EGRESS_KEY_BYTES=${EGRESS_KEY_BYTES}`,
  `EGRESS_MODE=${EGRESS_SHADOWSOCKS_MODE}`,
  `EGRESS_DNS_SERVERS="${EGRESS_DNS_SERVERS.join(' ')}"`,
  `EGRESS_EXIT_IP_ENDPOINTS="${EGRESS_EXIT_IP_ENDPOINTS.join(' ')}"`,
  `EGRESS_DIRECT_ROUTES="${EGRESS_DIRECT_ROUTES.join(' ')}"`,
  `EGRESS_NEW_CONN_RATE=${EGRESS_NEW_CONN_RATE}`,
  `EGRESS_NEW_CONN_BURST=${EGRESS_NEW_CONN_BURST}`,
  `EGRESS_UDP_RATE=${EGRESS_UDP_RATE}`,
  `EGRESS_UDP_BURST=${EGRESS_UDP_BURST}`,
  `EGRESS_OUT_CONN_RATE=${EGRESS_OUT_CONN_RATE}`,
  `EGRESS_OUT_CONN_BURST=${EGRESS_OUT_CONN_BURST}`,
  `EGRESS_UDP_TIMEOUT_SECONDS=${EGRESS_UDP_TIMEOUT_SECONDS}`,
  `EGRESS_UDP_MAX_ASSOCIATIONS=${EGRESS_UDP_MAX_ASSOCIATIONS}`,
].join('\n');

export const EGRESS_TUNNEL_SERVICE = 'okidoki-egress.service';
export const EGRESS_ROUTES_SERVICE = 'okidoki-egress-routes.service';

/** Benchmark range (RFC 2544) — never routed on the Internet and not used by Docker's default pools, so the tunnel can't collide with a customer network. */
export const EGRESS_TUNNEL_INTERFACE = 'rpxtun0';
export const EGRESS_TUNNEL_ADDRESS = '198.18.0.1/30';

export const EGRESS_PATHS = {
  /**
   * Under /run, which is tmpfs. The key therefore never touches disk and cannot
   * be carried into a filesystem snapshot or a paused sandbox's disk image. It
   * does not survive a reboot either. A full-memory resume can reuse it only
   * while the root-owned revision still matches the current profile and the
   * running service and route are healthy.
   */
  CONFIG_DIR: '/run/okidoki-egress',
  CONFIG_FILE: '/run/okidoki-egress/config.json',
  REVISION_FILE: '/run/okidoki-egress/revision',
  DESTINATIONS_FILE: '/run/okidoki-egress/destinations',
  /** Persistent: this records the workspace's original resolver so the tunnel can put it back, and must outlive a reboot. */
  RESOLV_BACKUP: '/var/lib/okidoki-egress-resolv.conf.orig',
  UNIT_FILE: `/etc/systemd/system/${EGRESS_TUNNEL_SERVICE}`,
  ROUTES_UNIT_FILE: `/etc/systemd/system/${EGRESS_ROUTES_SERVICE}`,
  UP_SCRIPT: '/usr/local/lib/okidoki-egress-up',
  DOWN_SCRIPT: '/usr/local/lib/okidoki-egress-down',
};

/**
 * The shell-facing half of the contract, written into the workspace image at
 * `EGRESS_WORKSPACE_CONFIG_FILE` so `verify-workspace.sh` can source it instead
 * of restating these values. Same arrangement as the exit host, where
 * `credentials.sh` sources what `deploy.sh` rendered: a change here reaches the
 * verifier rather than leaving it checking something that is no longer true.
 */
export const EGRESS_WORKSPACE_CONFIG_FILE = '/opt/okidoki/egress-config.env';

/** Substituted into `Dockerfile.sandbox` by name, so adding one here is enough to put it in front of the verifier. */
export const EGRESS_WORKSPACE_SHELL_VARS: Record<string, string> = {
  EGRESS_WORKSPACE_CONFIG_FILE,
  EGRESS_TUNNEL_SERVICE,
  EGRESS_TUNNEL_INTERFACE,
  EGRESS_DNS_SERVERS: EGRESS_DNS_SERVERS.join(' '),
  EGRESS_EXIT_IP_ENDPOINTS: EGRESS_EXIT_IP_ENDPOINTS.join(' '),
};

export interface EgressTunnelConfig {
  server: string;
  serverPort: number;
  password: string;
}

export function buildEgressClientConfig(config: EgressTunnelConfig): string {
  return `${JSON.stringify(
    {
      server: config.server,
      server_port: config.serverPort,
      password: config.password,
      method: EGRESS_CIPHER,
      mode: EGRESS_SHADOWSOCKS_MODE,
    },
    null,
    2,
  )}\n`;
}

export function isValidEgressPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Rejects a key the exit would refuse at startup, so a bad credential surfaces at registration rather than at workspace creation. */
export function isValidEgressKey(key: unknown): key is string {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length % 4 !== 0) return false;
  // Decoded length from the encoded shape rather than by decoding: this module
  // is typechecked inside packages that have no Node types, so Buffer is not
  // available here.
  const padding = key.length - key.replace(/=+$/, '').length;
  return (key.length / 4) * 3 - padding === EGRESS_KEY_BYTES;
}

/**
 * Must hold before a name is ever interpolated into a command on the exit host.
 * The same pattern the exit's own script enforces, checked here too so a
 * malformed name is rejected before it reaches a shell.
 */
export function isValidEgressCustomerName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,38}$/.test(name);
}

/** IPv4 literal only: the exit is addressed by its Elastic IP so a hostname can never repoint egress at an unallowlisted host. */
export function isValidEgressHost(host: unknown): host is string {
  if (typeof host !== 'string') return false;
  const octets = host.split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
