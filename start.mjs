/**
 * Murmur server launcher — auto-restarts on clean exit (code 0).
 * Exit code 0 = intentional restart (e.g. from the UI's Restart button).
 * Any other exit code = real error, stops relaunching.
 */
import { spawn } from "child_process";

function run() {
  console.log("[start] Starting server...");
  const proc = spawn("npx", ["tsx", "server.ts"], { stdio: "inherit", shell: false });
  proc.on("exit", (code) => {
    if (code === 0) {
      console.log("[start] Server exited cleanly — restarting in 1s...");
      setTimeout(run, 1000);
    } else {
      console.log(`[start] Server exited with code ${code} — not restarting`);
      process.exit(code ?? 1);
    }
  });
}

run();
