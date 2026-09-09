import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const publicDirectory = join(import.meta.dirname, "public");
const port = Number(process.env.PORT ?? 3000);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

createServer((request, response) => {
  const requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
  const candidate = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filename = normalize(join(publicDirectory, candidate));

  if (!filename.startsWith(`${publicDirectory}/`) || !existsSync(filename) || !statSync(filename).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentTypes[extname(filename)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff"
  });
  createReadStream(filename).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Rate Your Flow landing available on http://127.0.0.1:${port}`);
});
