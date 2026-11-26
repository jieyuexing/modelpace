import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class T3RpcError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'T3RpcError';
    if (status != null) this.status = status;
    if (code != null) this.code = code;
  }
}

export function splitCommandArgs(command) {
  if (Array.isArray(command)) {
    const argv = command.map((item) => String(item).trim()).filter(Boolean);
    if (!argv.length) throw new T3RpcError('Invalid empty tokenCommand');
    return argv;
  }
  if (typeof command !== 'string' || !command.trim()) {
    throw new T3RpcError('Invalid tokenCommand');
  }
  const argv = [];
  let current = '';
  let quote = null;
  let escape = false;
  for (const ch of command.trim()) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        argv.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escape || quote) throw new T3RpcError('Unterminated quote in tokenCommand');
  if (current) argv.push(current);
  if (!argv.length) throw new T3RpcError('Invalid empty tokenCommand');
  return argv;
}

export async function resolveBearer({ bearer, tokenCommand, timeoutMs = 10_000, signal } = {}) {
  if (typeof bearer === 'string' && bearer.trim()) {
    return bearer.trim();
  }
  if (!tokenCommand) return null;
  const [file, ...args] = splitCommandArgs(tokenCommand);
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      signal,
      maxBuffer: 1024 * 64,
      windowsHide: true,
    });
    const token = String(stdout ?? '').trim();
    if (!token) throw new T3RpcError('tokenCommand returned empty output');
    return token;
  } catch (error) {
    if (error instanceof T3RpcError) throw error;
    throw new T3RpcError('Failed to execute tokenCommand', {
      code: error?.code ?? 'TOKEN_COMMAND_FAILED',
    });
  }
}

async function fetchWebsocketTicket(origin, bearer, signal) {
  let response;
  let ticket = null;
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  try {
    response = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: 'POST',
      headers,
      signal,
    });
    if (response.ok) {
      const body = await response.json();
      if (typeof body?.ticket === 'string' && body.ticket) {
        ticket = body.ticket;
      }
    }
  } catch {
    ticket = null;
  }
  if (ticket) return ticket;
  throw new T3RpcError('Failed to obtain WebSocket ticket', {
    status: response?.status ?? null,
    code: 'WS_TICKET_FAILED',
  });
}

function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim()) {
    throw new T3RpcError('Invalid T3 server origin');
  }
  let parsed;
  try {
    parsed = new URL(origin.trim());
  } catch {
    throw new T3RpcError('Invalid T3 server origin URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new T3RpcError('T3 server origin must use http or https');
  }
  return parsed.origin;
}

/**
 * Connect to a T3 Code server via WebSocket RPC.
 * Supports either `connectT3(origin, bearer, { signal, timeoutMs })`
 * or `connectT3({ origin, bearer, tokenCommand, timeoutMs, signal })`.
 */
export async function connectT3(originOrOptions, bearerArg, extraOptions = {}) {
  const options = typeof originOrOptions === 'object' && originOrOptions !== null
    ? originOrOptions
    : { origin: originOrOptions, bearer: bearerArg, ...extraOptions };

  const origin = normalizeOrigin(options.origin);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 15_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const bearer = await resolveBearer({
    bearer: options.bearer,
    tokenCommand: options.tokenCommand,
    timeoutMs,
    signal: combinedSignal,
  });

  const ticket = await fetchWebsocketTicket(origin, bearer, combinedSignal);
  const wsOrigin = origin.replace(/^http/, 'ws');
  const wsUrl = `${wsOrigin}/ws?orchestrationProtocol=2&clientSurface=web&wsTicket=${encodeURIComponent(ticket)}`;
  const ws = new WebSocket(wsUrl);

  const pending = new Map();
  let nextId = 1;
  let broken = null;

  const breakAll = (message, code = 'WS_BROKEN') => {
    broken ??= new T3RpcError(message, { code });
    for (const entry of pending.values()) {
      entry.reject(broken);
    }
    pending.clear();
    try {
      ws.close();
    } catch {
      // ignore close errors
    }
  };

  const onAbort = () => breakAll('T3 RPC aborted or timed out', 'ABORTED');
  if (combinedSignal.aborted) {
    onAbort();
  } else {
    combinedSignal.addEventListener('abort', onAbort, { once: true });
  }

  await new Promise((resolve, reject) => {
    if (broken) return reject(broken);
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener(
      'error',
      () => reject(broken ?? new T3RpcError('WebSocket connection failed', { code: 'WS_ERROR' })),
      { once: true },
    );
    combinedSignal.addEventListener('abort', () => reject(broken), { once: true });
  });

  ws.addEventListener('error', () => breakAll('WebSocket connection failed', 'WS_ERROR'));
  ws.addEventListener('close', () => breakAll('WebSocket closed unexpectedly', 'WS_CLOSED'));
  ws.addEventListener('message', (event) => {
    let messages;
    try {
      const rawText = typeof event.data === 'string'
        ? event.data
        : Buffer.from(event.data).toString('utf8');
      messages = [JSON.parse(rawText)].flat();
    } catch {
      return breakAll('T3 returned invalid JSON frame', 'WS_INVALID_FRAME');
    }
    for (const frame of messages) {
      if (frame?._tag === 'Ping') {
        ws.send(JSON.stringify({ _tag: 'Pong' }));
        continue;
      }
      const entry = pending.get(frame?.requestId);
      if (!entry) continue;
      if (frame._tag === 'Chunk') {
        ws.send(JSON.stringify({ _tag: 'Ack', requestId: frame.requestId }));
        const values = frame.values ?? [];
        if (entry.stream === true || (typeof entry.stream === 'function' && entry.stream(values))) {
          pending.delete(frame.requestId);
          entry.resolve({ _tag: 'Chunk', values });
        }
      } else if (frame._tag === 'Exit') {
        pending.delete(frame.requestId);
        entry.resolve(frame.exit);
      }
    }
  });

  return {
    call: (tag, payload = {}, { stream = false } = {}) =>
      new Promise((resolve, reject) => {
        if (broken) return reject(broken);
        const id = String(nextId++);
        pending.set(id, { resolve, reject, stream });
        ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
      }),
    close: () => {
      combinedSignal.removeEventListener('abort', onAbort);
      broken ??= new T3RpcError('T3 RPC closed', { code: 'WS_CLOSED' });
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };
}

export function unwrapRpcExit(exit) {
  if (!exit || typeof exit !== 'object') {
    throw new T3RpcError('Empty RPC exit response', { code: 'RPC_EMPTY' });
  }
  if (exit._tag === 'Failure') {
    const message = exit.cause?.message || exit.cause?.defect || 'T3 RPC call failed';
    throw new T3RpcError(String(message), { code: 'RPC_FAILURE' });
  }
  if (exit._tag === 'Success') {
    return exit.value;
  }
  return exit;
}

export function validateT3ServerConfig(config) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.providers)) {
    throw new T3RpcError('server.getConfig did not return providers list', {
      code: 'INVALID_SERVER_CONFIG',
    });
  }
  return config;
}

export async function fetchT3ServerConfig(options = {}) {
  const rpc = await connectT3(options);
  try {
    const exit = await rpc.call('server.getConfig', {});
    return validateT3ServerConfig(unwrapRpcExit(exit));
  } finally {
    rpc.close();
  }
}
