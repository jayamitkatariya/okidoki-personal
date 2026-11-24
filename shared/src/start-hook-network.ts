import type { EnvironmentHookRunKind } from './routes/environment-hook-runs';
import { shellQuotePosix } from './runtime-env';

export interface ProxyRouteCheck {
  device: string | null;
  firewallRules: string[];
}

// Tensorlake's proxy connects from eth0's link subnet.
const PROXY_CIDR = '172.31.255.20/30';
const PROXY_OPENVPN_ROUTE = '172.31.255.20 255.255.255.252';

/** Without the proxy's address, eth0's gateway stands in: it is Tensorlake's proxy. */
export function proxyRouteCheckScript(proxyAddress: string | null): string {
  return [
    `addr=${proxyAddress ? shellQuotePosix(proxyAddress) : "$(ip -4 route show default dev eth0 | awk '{print $3; exit}')"}`,
    '[ -n "$addr" ] || exit 0',
    'ip -4 route get "$addr" 2>/dev/null | head -1',
    "sudo -n iptables -S 2>/dev/null | grep -E '^-P (INPUT|OUTPUT) DROP|^-A (INPUT|OUTPUT) .*-j (DROP|REJECT)' || true",
  ].join('\n');
}

export function parseProxyRouteCheck(output: string): ProxyRouteCheck | undefined {
  const lines = output.split('\n').filter(Boolean);
  const route = lines.find((line) => !line.startsWith('-'));
  if (!route) return undefined;
  return { device: route.match(/\bdev (\S+)/)?.[1] ?? null, firewallRules: lines.filter((line) => line.startsWith('-')) };
}

/** Only a reroute proves the proxy is cut off; a DROP rule may cover other traffic, so it only explains a failed probe. */
export function isProxyRouteBroken(check: ProxyRouteCheck | undefined): check is ProxyRouteCheck {
  return !!check?.device && check.device !== 'eth0';
}

const DOCS_URL = 'https://docs.okidoki.dev/features/workspaces/start-hook-networking';

export const ENGINE_UNREACHABLE_PATTERN = /Okidoki can't reach this workspace since its (?:start|warm) hook ran\. (.+?\.) (Keep .+?) See (https:\S+)$/m;

export function engineUnreachableMessage(check: ProxyRouteCheck | undefined, hook: EnvironmentHookRunKind): string {
  const device = check?.device && check.device !== 'eth0' ? check.device : null;
  const rule = check?.firewallRules[0];
  const what = device && /^(tailscale|wg|tun|tap|ppp|zt)/.test(device)
    ? `Your ${hook} hook connected a VPN (\`${device}\`) that now routes Okidoki' connection to this workspace.`
    : device
      ? `Your ${hook} hook changed routing so Okidoki' connection to this workspace leaves through \`${device}\` instead of \`eth0\`.`
      : rule
        ? `Your ${hook} hook added a firewall rule that blocks Okidoki' connection to this workspace (\`${rule}\`).`
        : `Your ${hook} hook changed the workspace's networking so Okidoki' connection to it fails.`;
  const how = device?.startsWith('tailscale')
    ? `For Tailscale, drop \`--accept-routes\` and \`--exit-node\`, or stop advertising a route that covers ${PROXY_CIDR}.`
    : device?.startsWith('wg')
      ? `For WireGuard, leave ${PROXY_CIDR} out of \`AllowedIPs\`.`
      : device && /^(tun|tap)/.test(device)
        ? `For OpenVPN, add \`route ${PROXY_OPENVPN_ROUTE} net_gateway\` to its config.`
        : rule
          ? `Allow traffic to and from ${PROXY_CIDR} ahead of that rule.`
          : `Exclude ${PROXY_CIDR} from any VPN tunnel or firewall rule.`;
  return `Okidoki can't reach this workspace since its ${hook} hook ran. ${what} Keep ${PROXY_CIDR} reachable through \`eth0\`. ${how} See ${DOCS_URL}`;
}
