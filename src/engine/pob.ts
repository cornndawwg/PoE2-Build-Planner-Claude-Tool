// Runs Path of Building (headless, via LuaJIT) as a long-lived child process and talks to it
// over JSON lines (see pob/host.lua).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface EnginePaths {
  luajit: string;
  /** Path of Building's src/ folder (the working directory it needs). */
  pobSrc: string;
  host: string;
}

/**
 * Where the engine lives: POE2BF_ENGINE_DIR, then engine/ inside the installed extension,
 * then the repo's vendor/ checkout for development. Undefined if none is present.
 */
export function findEngine(): EnginePaths | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: EnginePaths[] = [];
  const add = (root: string) => {
    candidates.push({
      luajit: join(root, "runtime", process.platform === "win32" ? "luajit.exe" : "luajit"),
      pobSrc: join(root, "pob", "src"),
      host: join(root, "host.lua"),
    });
  };
  if (process.env.POE2BF_ENGINE_DIR) add(process.env.POE2BF_ENGINE_DIR);
  // Installed extension: <bundle>/server/engine/pob.js → <bundle>/engine
  add(resolve(here, "..", "..", "engine"));
  // Development: <repo>/src/engine or <repo>/dist/engine → <repo>/vendor + <repo>/pob/host.lua
  const repo = resolve(here, "..", "..");
  candidates.push({
    luajit: join(repo, "vendor", "runtime", process.platform === "win32" ? "luajit.exe" : "luajit"),
    pobSrc: join(repo, "vendor", "pob", "src"),
    host: join(repo, "pob", "host.lua"),
  });
  return candidates.find((c) => existsSync(c.luajit) && existsSync(join(c.pobSrc, "HeadlessWrapper.lua")) && existsSync(c.host));
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class PobEngine {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail: string[] = [];

  constructor(
    private readonly paths: EnginePaths,
    private readonly log: (message: string) => void = () => {},
  ) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const child = spawn(this.paths.luajit, [this.paths.host], {
        cwd: this.paths.pobSrc,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      let isReady = false;

      createInterface({ input: child.stdout }).on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message: { ready?: boolean; error?: string; id?: number; ok?: boolean; result?: unknown };
        try {
          message = JSON.parse(trimmed);
        } catch {
          return; // not a protocol line
        }
        if (message.ready !== undefined) {
          if (message.ready) {
            isReady = true;
            this.log("Path of Building engine ready");
            resolveReady();
          } else {
            rejectReady(new Error(message.error ?? "Path of Building failed to start"));
          }
          return;
        }
        const pending = message.id !== undefined ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        this.pending.delete(message.id!);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error ?? "calculation failed"));
      });

      createInterface({ input: child.stderr }).on("line", (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      });

      const fail = (reason: string) => {
        const detail = this.stderrTail.slice(-8).join("\n");
        const error = new Error(`${reason}${detail ? `\n${detail}` : ""}`);
        if (!isReady) rejectReady(error);
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
        this.child = undefined;
        this.ready = undefined; // restart on the next request
      };
      child.on("error", (error) => fail(`Couldn't start Path of Building: ${error.message}`));
      child.on("exit", (code) => fail(`Path of Building stopped (exit code ${code})`));
    });
    return this.ready;
  }

  async request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error("Path of Building isn't running");
    const id = this.nextId++;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Path of Building took longer than ${timeoutMs / 1000}s`));
        this.stop(); // a stuck engine is restarted on the next request
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest as (v: unknown) => void, reject: rejectRequest, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }
}
