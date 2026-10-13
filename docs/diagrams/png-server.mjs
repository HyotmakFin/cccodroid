import http from "node:http"; import fs from "node:fs";
const D = process.argv[2];
http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split("?")[0]);
  if (q.method === "POST" && p.startsWith("/save/")) {
    const bufs = []; q.on("data", (d) => bufs.push(d)); q.on("end", () => { fs.writeFileSync(D + "/" + p.slice(6).replace(/[^\w.-]/g, ""), Buffer.concat(bufs)); r.end("ok"); });
    return;
  }
  try { const b = fs.readFileSync(D + p); r.writeHead(200, { "content-type": p.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8" }); r.end(b); }
  catch { r.writeHead(404); r.end(); }
}).listen(8799, "127.0.0.1");
