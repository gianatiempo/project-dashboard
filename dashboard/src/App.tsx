/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";
import type {
  LogPayload,
  Project,
  ProjectCardProps,
  StatusPayload,
} from "../types.d";
import axios from "axios";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

const API_BASE = "http://localhost:2000/api";

function App() {
  const [projects, setProjects] = useState<Record<string, Project[]>>({});
  const [loading, setLoading] = useState(true);

  const fetchProjects = async () => {
    try {
      const res = await axios.get(`${API_BASE}/projects`);
      setProjects(res.data);
    } catch (err) {
      console.error("Error fetching projects:", err);
      setProjects({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const onRunScript = async (folder: string, script: string) => {
    try {
      await axios.post(`${API_BASE}/projects/${folder}/run`, { script });
    } catch (err: any) {
      alert(
        `Error ejecutando ${script}: ${
          err.response?.data?.error || err.message
        }`
      );
    }
  };

  const onStop = async (folder: string) => {
    try {
      await axios.post(`${API_BASE}/projects/${folder}/stop`);
    } catch (err: any) {
      alert(
        `Error deteniendo ${folder}: ${
          err.response?.data?.error || err.message
        }`
      );
    }
  };

  if (loading) {
    return <div className="loading">Cargando proyectos...</div>;
  }

  return (
    <div className="App">
      {Object.keys(projects).length > 0 ? (
        Object.entries(projects).map(([groupName, projectList]) => (
          <section key={groupName}>
            <header>
              <h1>{groupName}</h1>
            </header>
            <main>
              {projectList.map((project) => (
                <ProjectCard
                  key={project.folder}
                  project={project}
                  onRunScript={onRunScript}
                  onStop={onStop}
                />
              ))}
            </main>
          </section>
        ))
      ) : (
        <p>
          No se encontraron proyectos. Asegúrate de tener proyectos al mismo
          nivel que este dashboard.
        </p>
      )}
    </div>
  );
}

export default App;

const ProjectCard = ({ project, onRunScript, onStop }: ProjectCardProps) => {
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(project.status === "running");
  const socketRef = useRef<Socket | null>(null);

  const terminalRef = useRef<{
    write: (text: string, isError?: boolean) => void;
    scrollToBottom: () => void;
  } | null>(null);

  useEffect(() => {
    const socket = io("http://localhost:2000", {
      transports: ["websocket"],
    });

    socketRef.current = socket;

    socket.emit("joinProject", project.folder);
    socket.emit("getStatus", project.folder);

    socket.on("log", (payload: LogPayload) => {
      if (terminalRef.current) {
        const isError = payload.type === "stderr" || payload.type === "error";
        terminalRef.current.write(payload.message, isError);
        terminalRef.current.scrollToBottom();
      }
    });

    socket.on("status", (payload: StatusPayload) => {
      if (payload.projectName !== project.folder) return;

      if (payload.status === "running") {
        setIsRunning(true);
        setIsStarting(false);
      } else {
        setIsRunning(false);
        setIsStarting(false);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [project.folder, isStarting]);

  const executeScript = async (script: string) => {
    if (isRunning || isStarting) return;

    setIsStarting(true);
    try {
      await onRunScript(project.folder, script);
    } catch (error) {
      setIsStarting(false);
    }
  };

  const handleStop = () => {
    onStop(project.folder);
    setIsStarting(false);
  };

  const handleTerminalReady = (api: {
    write: (text: string, isError?: boolean) => void;
    scrollToBottom: () => void;
  }) => {
    terminalRef.current = api;
  };

  const getStatusText = () => {
    if (isStarting) return "🟡 Iniciando...";
    if (isRunning) return "✅ Corriendo";
    return "🛑 Detenido";
  };

  const dynamicStyle = {
    padding: "10px 20px",
    background: isRunning ? "#e74c3c" : "#27ae60",
    color: "white",
    border: "none",
    cursor: isStarting ? "not-allowed" : "pointer",
    borderRadius: "4px",
    margin: "2px",
  };
  const staticStyle = {
    padding: "10px 20px",
    background: "#95a5a6",
    color: "white",
    border: "none",
    cursor: "pointer",
    borderRadius: "4px",
    margin: "2px",
  };

  return (
    <div className={`project-card ${isRunning ? "running" : ""}`}>
      <h3>{project.name}</h3>

      <p className="status">
        Estado: <strong>{getStatusText()}</strong>
      </p>

      <div className="scripts">
        <h4>Scripts disponibles:</h4>
        <ul>
          {Object.entries(project.scripts).map(([script]) => (
            <li key={script}>
              {script === "dev" || script === "test" ? (
                isRunning || isStarting ? (
                  <button
                    onClick={handleStop}
                    disabled={isStarting}
                    style={dynamicStyle}
                  >
                    {isStarting ? "Iniciando..." : `Detener ${script}`}
                  </button>
                ) : (
                  <button
                    onClick={() => executeScript(script)}
                    disabled={isStarting}
                    style={dynamicStyle}
                  >
                    {isStarting ? "Iniciando..." : `Ejecutar ${script}`}
                  </button>
                )
              ) : (
                <button
                  onClick={() => executeScript(script)}
                  style={staticStyle}
                >
                  Ejecutar {script}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <TerminalComponent id={project.folder} onReady={handleTerminalReady} />
    </div>
  );
};

interface TerminalComponentProps {
  id: string;
  onReady?: (api: {
    write: (text: string, isError?: boolean) => void;
    scrollToBottom: () => void;
  }) => void;
}

const TerminalComponent: React.FC<TerminalComponentProps> = ({
  id,
  onReady,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal({
      theme: { background: "#1e1e1e", foreground: "#f0f0f0" },
      cursorBlink: true,
      fontSize: 14,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current!);
    fitAddon.fit();

    term.writeln(`\x1b[1mTerminal for: ${id}\x1b[0m\r\n`);
    termRef.current = term;

    if (onReady) {
      onReady({
        write: (text, isError = false) => {
          if (!termRef.current) return;
          if (isError) {
            termRef.current.write(`\x1b[31m${text}\x1b[0m`);
          } else {
            termRef.current.write(text);
          }
        },
        scrollToBottom: () => {
          if (termRef.current) {
            termRef.current.scrollToBottom();
          }
        },
      });
    }

    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
    };
  }, [id, onReady]);

  const termStyle = {
    height: "400px",
    background: "#000",
    borderRadius: "6px",
    padding: "8px",
    overflow: "hidden",
    fontFamily: "monospace",
  };
  return <div ref={terminalRef} style={termStyle} />;
};
