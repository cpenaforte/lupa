import { spawn } from "node:child_process";
process.on("SIGTERM", () => process.exit(0));
const descendant = spawn(process.execPath, [new URL("./stubborn.mjs", import.meta.url).pathname], {
  stdio: ["ignore", "pipe", "inherit"],
});
descendant.stdout.once("data", () => {
  process.stdout.write(JSON.stringify({ parent: process.pid, descendant: descendant.pid }) + "\n");
});
setInterval(() => {}, 1000);
