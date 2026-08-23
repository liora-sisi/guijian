const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = 8765;
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${port}`).pathname);
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  const type = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
  response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  fs.createReadStream(target).pipe(response);
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`READY http://127.0.0.1:${port}/tests/synthetic.html\n`));
