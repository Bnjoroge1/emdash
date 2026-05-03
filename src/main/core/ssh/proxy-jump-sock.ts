import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

function splitProxyJumpEntry(proxyJump: string): { destination: string; port?: string } {
  const firstHop = proxyJump.split(',')[0]?.trim() ?? '';
  const uriMatch = firstHop.match(/^ssh:\/\/(?:(.+?)@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?$/i);
  if (uriMatch) {
    const user = uriMatch[1];
    const host = uriMatch[2];
    return { destination: user ? `${user}@${host}` : host, port: uriMatch[3] };
  }

  const ipv6Match = firstHop.match(/^(.*@)?(\[[^\]]+\])(?::(\d+))?$/);
  if (ipv6Match) {
    const user = ipv6Match[1]?.slice(0, -1);
    const host = ipv6Match[2];
    return { destination: user ? `${user}@${host}` : host, port: ipv6Match[3] };
  }

  const atIdx = firstHop.lastIndexOf('@');
  const hostPort = atIdx >= 0 ? firstHop.slice(atIdx + 1) : firstHop;
  const user = atIdx >= 0 ? firstHop.slice(0, atIdx) : '';
  const colonIdx = hostPort.lastIndexOf(':');

  if (colonIdx > 0) {
    const host = hostPort.slice(0, colonIdx);
    const port = hostPort.slice(colonIdx + 1);
    if (/^\d+$/.test(port)) {
      return { destination: user ? `${user}@${host}` : host, port };
    }
  }

  return { destination: firstHop };
}

export function buildProxyJumpSocket(
  targetHost: string,
  targetPort: number,
  proxyJump: string
): Duplex {
  const jump = splitProxyJumpEntry(proxyJump);
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-W',
    `${targetHost}:${targetPort}`,
  ];
  if (jump.port) {
    args.push('-p', jump.port);
  }
  args.push(jump.destination);

  const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const sock = Duplex.from({
    writable: child.stdin,
    readable: child.stdout,
  });
  let stderrOutput = '';

  child.once('error', (error) => {
    sock.destroy(error);
  });

  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    stderrOutput += chunk;
    // Cap retained stderr to prevent unbounded growth if the process is noisy.
    if (stderrOutput.length > 4096) {
      stderrOutput = stderrOutput.slice(-4096);
    }
  });

  child.once('exit', (code, signal) => {
    if (sock.destroyed || code === 0) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    const stderr = stderrOutput.trim();
    const detail = stderr ? `: ${stderr}` : '';
    sock.destroy(new Error(`ProxyJump command failed (${reason})${detail}`));
  });

  sock.once('close', () => {
    if (!child.killed) {
      child.kill();
    }
  });

  return sock;
}
