const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const includeFakeCarrier = process.argv.includes("--fake-carrier");

function getNpmRunCommand(script) {
  if (process.platform !== "win32") {
    return { command: "npm", args: ["run", script] };
  }

  const npmCliPath = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );

  if (!fs.existsSync(npmCliPath)) {
    throw new Error(`Unable to find npm CLI at ${npmCliPath}`);
  }

  // Spawning npm.cmd directly can fail with EINVAL on some Windows Node builds.
  return { command: process.execPath, args: [npmCliPath, "run", script] };
}

const services = [
  {
    name: "api",
    script: "dev",
    env: {
      ANALYTICS_WORKER_IN_PROCESS: "true",
      ANALYTICS_OUTBOX_IN_API: "false",
      INTEGRATION_OUTBOX_IN_API: "false",
    },
  },
  {
    name: "analytics-outbox",
    script: "worker:analytics-outbox",
    skip: process.env.DEV_STACK_NO_ANALYTICS_OUTBOX === "true",
  },
  {
    name: "integration-outbox",
    script: "worker:integration-outbox",
    skip: process.env.DEV_STACK_NO_INTEGRATION_OUTBOX === "true",
  },
  {
    name: "finance-outbox",
    script: "worker:finance-outbox",
    skip: process.env.DEV_STACK_NO_FINANCE_OUTBOX === "true",
  },
  {
    name: "finance-posting",
    script: "worker:finance-posting",
    skip: process.env.DEV_STACK_NO_FINANCE_POSTING === "true",
  },
  {
    name: "labels",
    script: "worker:labels",
    skip: process.env.DEV_STACK_NO_LABELS === "true",
  },
  {
    name: "fake-carrier",
    script: "fake:carrier",
    skip: !includeFakeCarrier,
  },
].filter((service) => !service.skip);

const children = new Map();
let shuttingDown = false;

function prefixLines(name, stream, output) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line) output.write(`[${name}] ${line}\n`);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    if (line) output.write(`[${name}] ${line}\n`);
  });
}

function startService(service) {
  const npmRun = getNpmRunCommand(service.script);
  const child = spawn(npmRun.command, npmRun.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(service.env || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.set(service.name, child);
  prefixLines(service.name, child.stdout, process.stdout);
  prefixLines(service.name, child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    children.delete(service.name);
    if (!shuttingDown) {
      console.error(
        `[dev-stack] ${service.name} exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      shutdown(code && code !== 0 ? code : 1);
    }
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[dev-stack] stopping services...");
  for (const [name, child] of children.entries()) {
    console.log(`[dev-stack] stopping ${name}`);
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children.values()) {
      child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 4000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(
  `[dev-stack] starting ${services.map((service) => service.name).join(", ")}`,
);
for (const service of services) {
  startService(service);
}
