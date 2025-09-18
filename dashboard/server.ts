/* eslint-disable @typescript-eslint/no-unused-vars */
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import http from "http";
import { Server, Socket } from "socket.io";
import type { LogPayload, Project, StatusPayload } from "./types";
import express, { type Request, type Response } from "express";
import { execa } from "execa";
import { fileURLToPath } from "url";
import { dirname } from "path";

type ExecaChildProcess = ReturnType<typeof execa>;

const emitToProject = (
  projectName: string,
  event: string,
  payload: LogPayload
) => {
  const normalizedMessage = payload.message.replace(/\r?\n/g, "\r\n");
  for (const [_, socket] of io.sockets.sockets) {
    if (socket.data?.project === projectName) {
      socket.emit(event, {
        ...payload,
        message: normalizedMessage,
      });
    }
  }
};

const emitStatusToProject = (projectName: string, payload: StatusPayload) => {
  for (const [_, socket] of io.sockets.sockets) {
    if (socket.data?.project === projectName) {
      socket.emit("status", payload);
    }
  }
};

const BASE_PATH = "../";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectsDir = path.join(__dirname, BASE_PATH);

const projectsToExclude = ["dashboard", "wiremock"];
const runningProcesses = new Map<string, ExecaChildProcess>();
const projectStatus = new Map<string, Omit<StatusPayload, "projectName">>();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:5173", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

app.get("/api/projects", async (_: Request, res: Response) => {
  try {
    const items = await fs.readdir(projectsDir);
    const folders = (
      await Promise.all(
        items
          .filter((item) => !item.startsWith("."))
          .map(async (item) => {
            const itemPath = path.join(projectsDir, item);
            const stat = await fs.stat(itemPath);
            return stat.isDirectory() ? item : null;
          })
      )
    ).filter((item): item is string => item !== null);

    const projects = (
      await Promise.all(
        folders.map(async (folder) => {
          if (projectsToExclude.includes(folder)) return null;

          const projectPath = path.join(projectsDir, folder);
          const pkgPath = path.join(projectPath, "app/package.json");

          try {
            const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
            const currentStatus = projectStatus.get(folder) || {
              status: "stopped",
            };

            return {
              name: pkg.description || "Missing project description",
              folder,
              path: projectPath,
              scripts: pkg.scripts || {},
              ...currentStatus,
            } as Project;
          } catch (err) {
            console.warn(`Failed to load project: ${folder}`, err);
            return null;
          }
        })
      )
    ).filter((proj): proj is Project => proj !== null);

    const response = projects.reduce<Record<string, Project[]>>(
      (groups, project) => {
        const baseName = project.folder.split("-").at(-2) || project.folder;
        (groups[baseName] ||= []).push(project);
        return groups;
      },
      {}
    );
    res.json(response);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/projects/:name/run", async (req: Request, res: Response) => {
  const { name } = req.params;
  const { script } = req.body as { script: string };

  if (runningProcesses.has(name)) {
    return res.status(400).json({
      error: "Process already running",
      message: `Project ${name} is already running.`,
    });
  }

  const projectPath = path.join(projectsDir, name, "app");

  try {
    const yarnProcess = execa("yarn", [script], {
      cwd: projectPath,
      stdio: "pipe",
      env: process.env,
    });
    runningProcesses.set(name, yarnProcess);

    // Mark as running immediately
    const status: Omit<StatusPayload, "projectName"> = {
      status: "running",
    };
    projectStatus.set(name, status);
    emitStatusToProject(name, {
      projectName: name,
      ...status,
    });

    yarnProcess.stdout.on("data", (chunk: Buffer) => {
      const log = chunk.toString();
      emitToProject(name, "log", { type: "stdout", message: log });
    });

    yarnProcess.stderr.on("data", (data: Buffer) => {
      const log = data.toString();
      emitToProject(name, "log", { type: "stderr", message: log });
    });

    yarnProcess.on("close", (code: number, signal: string) => {
      // Only clean up if this process is still the current one
      if (runningProcesses.get(name) === yarnProcess) {
        runningProcesses.delete(name);

        const message =
          signal === "SIGTERM"
            ? `\n🏁 Script "${script}" detenido por el usuario\n`
            : `\n🏁 Script "${script}" finalizado (código ${code})\n`;

        emitToProject(name, "log", { type: "end", message });

        const status: Omit<StatusPayload, "projectName"> = {
          status: "stopped",
        };
        projectStatus.set(name, status);
        emitStatusToProject(name, {
          projectName: name,
          ...status,
        });
      }
    });

    yarnProcess.on("error", (error: Error) => {
      // Don't log errors if the process was killed intentionally
      if (!error.message.includes("SIGTERM")) {
        emitToProject(name, "log", {
          type: "error",
          message: `Error en proceso: ${error.message}`,
        });
      }

      // Clean up on error
      if (runningProcesses.get(name) === yarnProcess) {
        runningProcesses.delete(name);
        const status: Omit<StatusPayload, "projectName"> = {
          status: "stopped",
        };
        projectStatus.set(name, status);
        emitStatusToProject(name, {
          projectName: name,
          ...status,
        });
      }
    });

    res.json({ success: true, message: `Ejecutando: ${script}` });
  } catch (err: unknown) {
    console.error("Failed to start process:", err);
    res.status(500).json({
      error: "Failed to start script",
      details: (err as Error).message,
    });
  }
});

app.post("/api/projects/:name/stop", async (req: Request, res: Response) => {
  const { name } = req.params;
  const proc = runningProcesses.get(name);

  if (proc) {
    try {
      // Try graceful shutdown first
      proc.kill("SIGTERM");

      // Set a timeout to force kill if process doesn't exit
      const forceKillTimeout = setTimeout(() => {
        if (runningProcesses.get(name) === proc) {
          proc.kill("SIGKILL");
          console.log(`Force killed process for ${name}`);
        }
      }, 5000); // 5 second timeout

      // Wait for process to exit but don't throw errors for killed processes
      await new Promise<void>((resolve) => {
        proc.once("close", () => {
          clearTimeout(forceKillTimeout);
          resolve();
        });

        proc.once("error", (err) => {
          // Ignore errors from killed processes
          if (!err.message.includes("SIGTERM")) {
            console.error(`Error stopping process for ${name}:`, err);
          }
          clearTimeout(forceKillTimeout);
          resolve();
        });
      });

      runningProcesses.delete(name);

      const status: Omit<StatusPayload, "projectName"> = {
        status: "stopped",
      };
      projectStatus.set(name, status);

      emitStatusToProject(name, {
        projectName: name,
        ...status,
      });
      emitToProject(name, "log", {
        type: "info",
        message: "✋ Proceso detenido por el usuario.",
      });

      res.json({ success: true, message: `Proyecto ${name} detenido.` });
    } catch (error) {
      console.error(`Error stopping process for ${name}:`, error);
      res.status(500).json({ error: `Error stopping process for ${name}` });
    }
  } else {
    res.status(404).json({ error: `No hay proceso activo para ${name}` });
  }
});

// Add error handling to prevent backend crashes
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

io.on("connection", (socket: Socket) => {
  socket.data = socket.data || {};

  socket.on("joinProject", (projectName: string) => {
    socket.data.project = projectName;

    const projectsWithListeners = new Set<string>();
    for (const s of io.sockets.sockets.values()) {
      if (s.data?.project) projectsWithListeners.add(s.data.project);
    }
    io.emit("connectedProjects", [...projectsWithListeners]);
  });

  socket.on("getStatus", (projectName: string) => {
    const currentStatus = projectStatus.get(projectName) || {
      status: "stopped",
    };
    socket.emit("status", {
      projectName,
      ...currentStatus,
    });
  });

  socket.on("disconnect", () => {
    const projectsWithListeners = new Set<string>();
    for (const s of io.sockets.sockets.values()) {
      if (s.data?.project) projectsWithListeners.add(s.data.project);
    }
    io.emit("connectedProjects", [...projectsWithListeners]);
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 2000;

server.listen(PORT, () => {
  console.log(`🚀 Backend con WebSocket corriendo en http://localhost:${PORT}`);
});
