const net = require("node:net");
const { spawn } = require("node:child_process");
const waitOn = require("wait-on");

async function findFreePort(start) {
  let port = start;
  while (port < start + 50) {
    const free = await canListen(port);
    if (free) return port;
    port += 1;
  }
  throw new Error("사용 가능한 dev 포트를 찾을 수 없습니다.");
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function main() {
  const rendererPort = await findFreePort(5173);
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;

  console.log(`[skill-bridge] renderer port: ${rendererPort}`);

  const env = {
    ...process.env,
    RENDERER_PORT: String(rendererPort),
    SKILL_BRIDGE_RENDERER_URL: rendererUrl
  };

  const children = [];
  let shuttingDown = false;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) {
        child.kill();
      }
    }
    process.exit(code);
  };

  const startProc = (label, command, args) => {
    const child = spawn(command, args, {
      env,
      shell: true,
      stdio: "inherit"
    });

    children.push(child);
    child.on("exit", (code) => {
      if (!shuttingDown && code && code !== 0) {
        console.error(`[${label}] exited with ${code}`);
        shutdown(code);
      }
    });

    return child;
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  startProc("core", "npm", ["run", "dev:core"]);
  startProc("main", "npm", ["run", "dev:main"]);
  startProc("preload", "npm", ["run", "dev:preload"]);
  startProc("renderer", "npm", ["run", "dev:renderer", "--", "--port", String(rendererPort), "--host", "127.0.0.1"]);

  await waitOn({
    resources: [
      `tcp:127.0.0.1:${rendererPort}`,
      "file:apps/desktop/dist/main/index.js",
      "file:apps/desktop/dist/preload/index.js",
      "file:packages/core/dist/index.js"
    ],
    timeout: 120000
  });

  startProc("electron", "npx", [
    "nodemon",
    "--watch",
    "apps/desktop/dist/main",
    "--watch",
    "apps/desktop/dist/preload",
    "--exec",
    "electron apps/desktop/dist/main/index.js"
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
