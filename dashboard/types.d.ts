// types.d.ts

export interface LogPayload {
  type: "stdout" | "stderr" | "info" | "end" | "error";
  message: string;
  code?: number;
}

export interface StatusPayload {
  projectName: string;
  status: "stopped" | "running";
}

export interface Project {
  name: string;
  folder: string;
  path: string;
  scripts: Record<string, string>;
  status: "stopped" | "running";
}

export interface ProjectCardProps {
  project: Project;
  onRunScript: (projectName: string, script: string) => Promise<void>;
  onStop: (projectName: string) => Promise<void>;
}
