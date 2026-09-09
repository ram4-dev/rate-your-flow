import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const publicDirectory = join(import.meta.dirname, "..", "public");
const requiredFiles = ["index.html", "styles.css", "app.js"];

for (const file of requiredFiles) {
  await access(join(publicDirectory, file));
}

const [html, css] = await Promise.all([
  readFile(join(publicDirectory, "index.html"), "utf8"),
  readFile(join(publicDirectory, "styles.css"), "utf8")
]);

if (!html.includes('href="styles.css"') || !html.includes('src="app.js"')) {
  throw new Error("Landing entrypoint must load its local CSS and JavaScript assets.");
}

if (css.includes("http://") || css.includes("https://")) {
  throw new Error("Landing assets must remain self-contained.");
}

console.log(`Static landing ready: ${requiredFiles.join(", ")}`);
