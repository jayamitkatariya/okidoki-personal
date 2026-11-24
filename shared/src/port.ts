export function isValidPort(port: unknown): port is number {
  return Number.isInteger(port) && Number(port) >= 1 && Number(port) <= 65535;
}

export function parsePort(port: string): number {
  if (!/^\d+$/.test(port)) throw new Error('Port must be a number between 1 and 65535');
  const portNumber = Number(port);
  if (!isValidPort(portNumber)) throw new Error('Port must be a number between 1 and 65535');
  return portNumber;
}
