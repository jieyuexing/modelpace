import http from 'node:http';
import crypto from 'node:crypto';

function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (pos + 2 > buffer.length) break;
      len = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + len > buffer.length) break;
    const mask = masked ? buffer.subarray(pos, pos + 4) : null;
    pos += maskLen;
    const data = Buffer.from(buffer.subarray(pos, pos + len));
    if (mask) {
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    }
    frames.push({ opcode, text: data.toString('utf8') });
    offset = pos + len;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function startMockT3Server({ expectedToken = 'secret-token', serverConfigPayload }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/auth/websocket-ticket') {
      if (req.headers.authorization !== `Bearer ${expectedToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ticket: 'ws-ticket-123' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/ws' || url.searchParams.get('wsTicket') !== 'ws-ticket-123') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    let recv = Buffer.alloc(0);
    let sawPong = false;

    socket.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      const { frames, rest } = decodeWsFrames(recv);
      recv = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.end();
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        const msg = JSON.parse(frame.text);
        if (msg._tag === 'Pong') {
          sawPong = true;
          continue;
        }
        if (msg._tag === 'Request' && msg.tag === 'server.getConfig') {
          socket.write(encodeWsTextFrame(JSON.stringify({ _tag: 'Ping' })));
          setTimeout(() => {
            socket.write(
              encodeWsTextFrame(
                JSON.stringify({
                  _tag: 'Exit',
                  requestId: msg.id,
                  exit: { _tag: 'Success', value: serverConfigPayload },
                }),
              ),
            );
          }, 10);
        } else if (msg._tag === 'Request' && msg.tag === 'stream.test') {
          socket.write(
            encodeWsTextFrame(
              JSON.stringify({ _tag: 'Chunk', requestId: msg.id, values: [{ ok: true, sawPong }] }),
            ),
          );
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}
