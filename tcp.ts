import net from 'net'; // 导入 net 模块

const UUID = import.meta.env.UUID || "ad589139-445a-4958-812e-9d220800d3d1";
const PORT = import.meta.env.PORT || 3000;
const WSPATH = import.meta.env.WSPATH || "/";
const PROXY = import.meta.env.PROXY || "";

console.log(`正在启动 VLESS 服务...`);

Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") !== "websocket") {
        // ... (保持原有的 HTML 逻辑不变) ...
        return new Response(`My Bun Server is running`);
    }
    if (url.pathname !== WSPATH) return new Response("Not Found", { status: 404 });
    if (server.upgrade(req)) return;
    return new Response("Unauthorized", { status: 401 });
  },
  websocket: {
    async open(ws) {
      (ws as any).remoteConn = null;
      (ws as any).isHeaderSent = false;
    },
    async message(ws, message) {
      if (!(message instanceof Buffer)) return;
      const remote = (ws as any).remoteConn;

      if (remote) {
        remote.write(message);
        return;
      }

      // --- 解析 VLESS 协议 (保持不变) ---
      const buf: any = Uint8Array.from(message);
      const version = buf[0];
      const clientUUID = Array.from(buf.slice(1, 17))
        .map((b: any) => b.toString(16).padStart(2, "0"))
        .join("")
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

      if (clientUUID !== UUID) { ws.close(); return; }

      let offset = 17;
      offset += buf[offset++] + 1;
      const command = buf[offset++];
      const remotePort = (buf[offset++] << 8) | buf[offset++];
      const addrType: any = buf[offset++];
      let hostraw: Uint8Array;
      let remoteAddr = "";

      if (addrType === 1) {
        remoteAddr = buf.slice(offset, offset + 4).join(".");
        hostraw = buf.slice(offset, offset + 4);
        offset += 4;
      } else if (addrType === 2) {
        const len = buf[offset++];
        remoteAddr = new TextDecoder().decode(buf.slice(offset, offset + len));
        hostraw = buf.slice(offset, offset + len);
        offset += len;
      } else { ws.close(); return; }

      const firstpayload = buf.slice(offset);
      const proxyHost: any = PROXY.split(":")[0];
      const proxyPort = parseInt(PROXY.split(":")[1] || "");

      // --- 关键修改：改用 net.connect ---
      try {
        const socket = net.connect({
          host: !!PROXY ? proxyHost : remoteAddr,
          port: !!PROXY ? proxyPort : remotePort,
          // 注意：这里不需要显式写 localAddress，因为 bindip.js 会帮你注入
        });

        (ws as any).remoteConn = socket;

        // 处理连接成功
        socket.on('connect', () => {
          if (PROXY !== "") {
            const handshake = new Uint8Array([0x05, 0x01, 0x00]);
            socket.write(handshake);
            (socket as any).handshakeSent = true;
          } else {
            // 直连模式，如果握手带了数据，直接发出去
            if (firstpayload.length > 0) socket.write(firstpayload);
          }
        });

        // 处理数据收发
        socket.on('data', (data) => {
          const res = Uint8Array.from(data);
          if (PROXY !== "") {
            // SOCKS5 状态机逻辑
            if (res[0] === 0x05 && res[1] === 0x00 && !(socket as any).requestSent) {
              const req = new Uint8Array(6 + (addrType === 2 ? hostraw.length + 1 : hostraw.length));
              req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = addrType;
              let pos = 4;
              if (addrType === 2) { req[pos++] = hostraw.length; }
              req.set(hostraw, pos);
              pos += hostraw.length;
              req[pos++] = (remotePort >> 8) & 0xff;
              req[pos++] = remotePort & 0xff;
              socket.write(req);
              (socket as any).requestSent = true;
            } 
            else if (res[0] === 0x05 && res[1] === 0x00 && (socket as any).requestSent && !(socket as any).proxyReady) {
              (socket as any).proxyReady = true;
              if (!(ws as any).isHeaderSent) {
                ws.send(new Uint8Array([version, 0]));
                (ws as any).isHeaderSent = true;
              }
              if (firstpayload.length > 0) socket.write(firstpayload);
            } 
            else if ((socket as any).proxyReady) {
              ws.send(data);
            }
          } else {
            // 直连模式
            if (!(ws as any).isHeaderSent) {
              ws.send(new Uint8Array([version, 0]));
              (ws as any).isHeaderSent = true;
            }
            ws.send(data);
          }
        });

        socket.on('close', () => ws.close());
        socket.on('error', () => ws.close());

      } catch (e) {
        ws.close();
      }
    },
    close(ws) {
      (ws as any).remoteConn?.end();
    }
  }
});