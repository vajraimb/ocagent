import { createServer } from "node:http";

const port = 8765;
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/spec") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end('{"ok":true}\n');
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1");
