// index.ts
const UUID = import.meta.env.UUID || "ad589139-445a-4958-812e-9d220800d3d1"; // 建议更换为你自己的 UUID
const PORT = import.meta.env.PORT || 3000;
const WSPATH = import.meta.env.WSPATH || "/";
const PROXY = import.meta.env.PROXY || "";

console.log(`正在启动 VLESS 服务...`);

Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    const host = req.headers.get("host") || "localhost";
    // --- 逻辑 A: 网页前端 (生成配置链接) ---
    if (req.headers.get("upgrade") !== "websocket") {
        const remarks = `Bun_VLESS_${host.split('.')[0]}`;
        const vlessUrl = `vless://${UUID}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(WSPATH)}&packetEncoding=xudp#${encodeURIComponent(remarks)}`;
        if (url.pathname === `/${UUID}`) {
            return new Response(`
                <!DOCTYPE html>
                <html lang="zh-CN">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>VLESS Node Config</title>
                    <script src="https://cdn.tailwindcss.com"></script>
                </head>
                <body class="bg-slate-900 text-slate-200 min-h-screen flex items-center justify-center p-4">
                    <div class="max-w-2xl w-full bg-slate-800 rounded-2xl shadow-2xl p-8 border border-slate-700">
                        <h1 class="text-2xl font-bold mb-6 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
                            VLESS 服务已启动
                        </h1>
                        
                        <div class="mb-6">
                            <label class="block text-sm font-medium text-slate-400 mb-2">v2rayN 订阅/节点链接 (已开启 xudp 绕过 UDP 封禁)</label>
                            <textarea id="vless-link" readonly class="w-full h-24 bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs break-all focus:ring-2 focus:ring-blue-500 outline-none">${vlessUrl}</textarea>
                        </div>

                        <div class="flex gap-4 mb-8">
                            <button onclick="copyLink()" class="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-4 rounded-lg transition-all">
                                复制链接
                            </button>
                            <a href="https://github.com/2dust/v2rayN/releases" target="_blank" class="flex-1 bg-slate-700 hover:bg-slate-600 text-center py-2 px-4 rounded-lg transition-all">
                                下载 v2rayN
                            </a>
                        </div>

                        <div class="space-y-3 text-sm border-t border-slate-700 pt-6">
                            <div class="flex justify-between"><span class="text-slate-500">服务器地址:</span> <span class="text-emerald-400">${host}</span></div>
                            <div class="flex justify-between"><span class="text-slate-500">端口:</span> <span>443 (TLS)</span></div>
                            <div class="flex justify-between"><span class="text-slate-500">UUID:</span> <span class="font-mono text-xs">${UUID}</span></div>
                            <div class="flex justify-between"><span class="text-slate-500">UDP 支持:</span> <span class="text-blue-400 text-xs font-mono">packetEncoding=xudp</span></div>
                        </div>
                    </div>

                    <script>
                    function copyLink() {
                        const copyText = document.getElementById("vless-link");
                        copyText.select();
                        document.execCommand("copy");
                        alert("链接已复制！在 v2rayN 中 Ctrl+V 即可。");
                    }
                    </script>
                </body>
                </html>
            `, { headers: { "content-type": "text/html; charset=utf-8" } });
        } else if(url.pathname === '/') {
            console.log("-- HTML --");
            return new Response(`My Bun VLESS Server is running`,{
                headers:{
                "content-type": "text/pain; charset=utf-8"
                }
            })
        }
    }
    // --- 逻辑 B: VLESS 隧道核心逻辑 ---
    if (url.pathname !== WSPATH) {
        return new Response("Not Found", { status: 404 });
    }
    // 强制尝试升级到 WebSocket
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

      // 解析 VLESS 协议
      const buf:any = Uint8Array.from(message);
      const version = buf[0];
      const clientUUID = Array.from(buf.slice(1, 17))
        .map((b:any) => b.toString(16).padStart(2, "0"))
        .join("")
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

      if (clientUUID !== UUID) {
        ws.close();
        return;
      }

      let offset = 17;
      offset += buf[offset++] + 1; // 跳过 Add-on
      const command = buf[offset++]; 
      const remotePort = (buf[offset++] << 8) | buf[offset++];
      const addrType:any = buf[offset++];
      let host: string | Uint8Array;
      let hostraw: Uint8Array;
      let remoteAddr = "";

      if (addrType === 1) { // IPv4
        remoteAddr = buf.slice(offset, offset + 4).join(".");
        hostraw = buf.slice(offset, offset + 4);
        host = hostraw.join(".");
        offset += 4;
      } else if (addrType === 2) { // Domain
        const len = buf[offset++];
        remoteAddr = new TextDecoder().decode(buf.slice(offset, offset + len));
        hostraw = buf.slice(offset, offset + len);
        host = new TextDecoder().decode(hostraw);
        offset += len;
      } else {
        ws.close();
        return;
      }

      const firstpayload = buf.slice(offset);

    //    代理地址 127.0.0.1:8080 分拆
      const proxyHost:any = PROXY.split(":")[0];
      const proxyPort = parseInt(PROXY.split(":")[1]||"");

      try {
        const socket = await Bun.connect({
          hostname: !!PROXY ? proxyHost : remoteAddr,
          port: !!PROXY ? proxyPort : remotePort,
          socket: {
            data(s, data) {
                const res = Uint8Array.from(data);
                // 代理了
                if(PROXY !== "") {
                    // 状态机：处理 socks5 响应
                    if (res[0] === 0x05 && res[1] === 0x00 && !(s as any).requestSent) {
                        // 收到握手确认，发送连接请求 (command: 0x01 connect)
                        const req = new Uint8Array(6 + (addrType === 2 ? hostraw.length + 1 : hostraw.length));
                        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = addrType;
                        let pos = 4;
                        if (addrType === 2) { req[pos++] = hostraw.length; }
                        req.set(hostraw, pos);
                        pos += hostraw.length;
                        req[pos++] = (remotePort >> 8) & 0xff;
                        req[pos++] = remotePort & 0xff;
                        
                        s.write(req);
                        (s as any).requestSent = true;
                    } else if (res[0] === 0x05 && res[1] === 0x00 && (s as any).requestSent && !(s as any).proxyReady) {
                        // 连接目标成功
                        (s as any).proxyReady = true;
                        // 发送 vless 响应头并透传初始数据
                        if (!(ws as any).isHeaderSent) {
                        ws.send(new Uint8Array([version, 0]));
                        (ws as any).isHeaderSent = true;
                        }
                        if (firstpayload.length > 0) s.write(firstpayload);
                    }  else if ((s as any).proxyReady) {
                        // 代理完全就绪，进入纯透传模式
                        ws.send(data);
                    }
                } else {
                    if (!(ws as any).isHeaderSent) {
                        ws.send(new Uint8Array([version, 0]));
                        (ws as any).isHeaderSent = true;
                    }
                    ws.send(data);
                }
            },
            close() { ws.close(); },
            error() { ws.close(); }
          }
        });
        (ws as any).remoteConn = socket;
        const remain = buf.slice(offset);
        if (remain.length > 0) socket.write(remain);
      } catch (e) {
        ws.close();
      }
    },
    close(ws) {
      (ws as any).remoteConn?.end();
    }
  }
});

console.log(`✅ 运行成功！\nIP: 你的服务器IP\n端口: ${PORT}\nUUID: ${UUID}\nWSPATH: ${WSPATH}`);