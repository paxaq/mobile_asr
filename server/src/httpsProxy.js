import "dotenv/config";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const TARGET_HOST = process.env.TARGET_HOST || "localhost";
const TARGET_PORT = Number(process.env.TARGET_PORT || 8080);

const certPath = process.env.HTTPS_CERT || path.resolve(__dirname, "..", "..", "certs", "localhost.pem");
const keyPath = process.env.HTTPS_KEY || path.resolve(__dirname, "..", "..", "certs", "localhost-key.pem");

const tlsOptions = {
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath)
};

const server = https.createServer(tlsOptions, (req, res) => {
  const options = {
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Proxy error: ${err.message}`);
  });

  req.pipe(proxyReq, { end: true });
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (client, request) => {
  const targetUrl = `ws://${TARGET_HOST}:${TARGET_PORT}${request.url}`;
  const proxy = new WebSocket(targetUrl, {
    headers: request.headers
  });

  const closeBoth = () => {
    try { client.close(); } catch {}
    try { proxy.close(); } catch {}
  };

  proxy.on("open", () => {
    client.on("message", (data) => {
      if (proxy.readyState === WebSocket.OPEN) proxy.send(data);
    });
  });

  proxy.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });

  proxy.on("close", closeBoth);
  proxy.on("error", closeBoth);
  client.on("close", closeBoth);
  client.on("error", closeBoth);
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(HTTPS_PORT, () => {
  console.log(`HTTPS proxy listening on :${HTTPS_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`);
});