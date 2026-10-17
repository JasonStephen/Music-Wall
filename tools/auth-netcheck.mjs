// Anonymous live probe only: creates a QR session and checks its waiting state.
// Does not print the QR key, cookie values, or perform account authorization.
import { build } from "esbuild";
const built = await build({ entryPoints: ["src/core/auth.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { createQrLogin, checkQrLogin } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const request = async (req) => {
  const response = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(15000) });
  return { status: response.status, text: await response.text(), headers: { "set-cookie": response.headers.getSetCookie() } };
};
try {
  const session = await createQrLogin(request);
  const code = await checkQrLogin(request, session);
  if (code !== 801) throw new Error("Unexpected anonymous QR status: " + code);
  console.log("PASS: real NetEase QR session generated, image rendered locally, status 801 (waiting for scan).");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
