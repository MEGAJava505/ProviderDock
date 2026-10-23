import net from "node:net";

const startedAtUtc = new Date().toISOString();
const report = value => process.stdout.write(`${JSON.stringify({ ...value, startedAtUtc, endedAtUtc: new Date().toISOString(), attempts: 1 })}\n`);
const socket = net.connect({ host: "192.0.2.1", port: 443 });
const timer = setTimeout(() => {
  report({ status: "FAIL", code: "TIMEOUT" });
  socket.destroy();
  process.exit(2);
}, 4000);
socket.once("connect", () => {
  clearTimeout(timer);
  report({ status: "FAIL", code: "CONNECTED" });
  socket.destroy();
  process.exit(3);
});
socket.once("error", error => {
  clearTimeout(timer);
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
  const denied = code === "EACCES" || Math.abs(error.errno) === 10013;
  report({ status: denied ? "PASS" : "FAIL", code, errno: error.errno ?? null });
  process.exit(denied ? 0 : 4);
});
