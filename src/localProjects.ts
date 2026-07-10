import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import type { T3Project, T3Runtime } from "./types.js";

interface ProjectRow {
  project_id: string;
  title: string;
  workspace_root: string;
  default_model_selection_json: string | null;
  scripts_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readLocalProjects(runtime: T3Runtime): T3Project[] | null {
  if (!runtime.stateDir) return null;
  const dbPath = path.join(runtime.stateDir, "state.sqlite");
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const rows = database
      .prepare(
        `SELECT project_id, title, workspace_root, default_model_selection_json,
                scripts_json, created_at, updated_at, deleted_at
           FROM projection_projects
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC`,
      )
      .all() as unknown as ProjectRow[];
    return rows.map((row) => ({
      id: row.project_id,
      title: row.title,
      workspaceRoot: row.workspace_root,
      defaultModelSelection: parseJson(row.default_model_selection_json, null),
      scripts: parseJson(row.scripts_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    }));
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
