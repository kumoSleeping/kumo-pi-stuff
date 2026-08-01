/**
 * Bash Jobs — non-blocking bash execution with background job control.
 *
 * Overrides the built-in `bash` tool: commands run detached and are handed off
 * after 15 seconds as a job (cmd-N); `bash_job` waits for, inspects, or stops
 * the job. A user abort of the tool call never kills the process (detach-on-
 * abort); the job keeps running in the background under its job ID.
 *
 * Env:
 *   BASH_JOBS_KILL_ON_ABORT=1  restore the legacy kill-on-abort behavior
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getShellConfig,
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const HANDOFF_AFTER_SECONDS = 15;
const MAX_WAIT_SECONDS = 86_400;
const FORCE_KILL_AFTER_MS = 2_000;
const STOP_WAIT_MS = 3_000;
const UPDATE_THROTTLE_MS = 100;
// Default: a user abort detaches the tool call but NEVER kills the process —
// the job keeps running in the background and can be followed or stopped via
// bash_job. Set BASH_JOBS_KILL_ON_ABORT=1 to restore the legacy kill-on-abort.
const KILL_ON_ABORT = process.env.BASH_JOBS_KILL_ON_ABORT === "1";
const MAX_RETAINED_JOBS = 50;
const COMPLETED_JOB_RETENTION_MS = 60 * 60 * 1_000;

type JobStatus = "running" | "stopping" | "exited" | "failed" | "stopped";
type StopReason = "user" | "abort" | "shutdown";

type Job = {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  startedAt: number;
  status: JobStatus;
  stopReason?: StopReason;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  error?: string;
  outputPath: string;
  outputStream: WriteStream;
  logError?: string;
  pending: string;
  droppedBytes: number;
  droppedLines: number;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  completion: Promise<void>;
  finish: () => void;
  finalized: boolean;
  forceKillTimer?: NodeJS.Timeout;
  retentionTimer?: NodeJS.Timeout;
};

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
});

const jobSchema = Type.Object({
  action: StringEnum(["wait", "status", "stop"] as const, {
    description: "wait for more output/completion, inspect immediately, or stop the process",
  }),
  jobId: Type.String({ description: "Background job ID returned by bash" }),
  seconds: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: MAX_WAIT_SECONDS,
      description: "Seconds to wait (required for action=wait); choose based on expected progress",
    }),
  ),
});

function isTerminal(job: Job): boolean {
  return job.status === "exited" || job.status === "failed" || job.status === "stopped";
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function appendPending(job: Job, text: string): void {
  if (!text) return;
  const combined = job.pending + text;
  const truncation = truncateTail(combined, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (truncation.truncated) {
    job.droppedBytes += truncation.totalBytes - truncation.outputBytes;
    job.droppedLines += truncation.totalLines - truncation.outputLines;
  }
  job.pending = truncation.content;
}

function pauseOutput(job: Job): void {
  job.child.stdout?.pause();
  job.child.stderr?.pause();
}

function resumeOutput(job: Job): void {
  job.child.stdout?.resume();
  job.child.stderr?.resume();
}

function appendOutput(job: Job, data: Buffer, decoder: StringDecoder): void {
  appendPending(job, decoder.write(data));
  if (!job.logError && !job.outputStream.write(data)) pauseOutput(job);
}

function flushDecoders(job: Job): void {
  appendPending(job, job.stdoutDecoder.end());
  appendPending(job, job.stderrDecoder.end());
}

function readPending(job: Job, consume: boolean): string {
  const output = job.pending.trimEnd();
  const droppedBytes = job.droppedBytes;
  const droppedLines = job.droppedLines;
  if (consume) {
    job.pending = "";
    job.droppedBytes = 0;
    job.droppedLines = 0;
  }
  const omissions: string[] = [];
  if (droppedLines > 0) omissions.push(`${droppedLines} earlier lines`);
  if (droppedBytes > 0) omissions.push(`${droppedBytes} earlier bytes`);
  const prefix = omissions.length > 0 ? `[${omissions.join(" and ")} omitted; full output: ${job.outputPath}]\n` : "";
  return `${prefix}${output}`.trimEnd();
}

function elapsedSeconds(job: Job): string {
  return ((Date.now() - job.startedAt) / 1000).toFixed(1);
}

function sendSignal(job: Job, signal: NodeJS.Signals): void {
  if (!job.child.pid || isTerminal(job)) return;
  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL") {
        const killer = spawn("taskkill", ["/pid", String(job.child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
      } else {
        job.child.kill(signal);
      }
    } else {
      process.kill(-job.child.pid, signal);
    }
  } catch {
    try {
      job.child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

function requestStop(job: Job, reason: StopReason): void {
  if (isTerminal(job) || job.status === "stopping") return;
  job.status = "stopping";
  job.stopReason = reason;
  sendSignal(job, "SIGTERM");
  job.forceKillTimer = setTimeout(() => {
    if (!isTerminal(job)) sendSignal(job, "SIGKILL");
  }, FORCE_KILL_AFTER_MS);
  job.forceKillTimer.unref();
}

async function waitForJob(job: Job, milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (isTerminal(job) || milliseconds <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    void job.completion.then(finish);
  });
}

function finalStatus(job: Job): string {
  if (job.status === "running") return `Job ${job.id} is still running (${elapsedSeconds(job)}s elapsed).`;
  if (job.status === "stopping") return `Job ${job.id} is stopping (${elapsedSeconds(job)}s elapsed).`;
  if (job.status === "stopped") return `Job ${job.id} was stopped after ${elapsedSeconds(job)}s.`;
  if (job.status === "failed") {
    if (job.error) return `Job ${job.id} failed to start: ${job.error}`;
    if (job.signalCode) return `Job ${job.id} was terminated by ${job.signalCode} after ${elapsedSeconds(job)}s.`;
    return `Job ${job.id} failed after ${elapsedSeconds(job)}s.`;
  }
  return job.exitCode === 0
    ? `Job ${job.id} completed successfully in ${elapsedSeconds(job)}s.`
    : `Job ${job.id} exited with code ${job.exitCode} after ${elapsedSeconds(job)}s.`;
}

function terminalFailure(job: Job): boolean {
  if (!isTerminal(job)) return false;
  if (job.stopReason === "user" || job.stopReason === "shutdown") return false;
  return job.status === "failed" || job.exitCode !== 0;
}

function logWarning(job: Job): string | undefined {
  return job.logError ? `Full output log may be incomplete: ${job.logError}` : undefined;
}

export default function bashJobs(pi: ExtensionAPI) {
  const jobs = new Map<string, Job>();
  let nextJobId = 1;

  function removeJob(job: Job): void {
    if (!isTerminal(job)) return;
    if (job.retentionTimer) clearTimeout(job.retentionTimer);
    jobs.delete(job.id);
    try {
      rmSync(dirname(job.outputPath), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  function pruneJobs(): void {
    const completed = [...jobs.values()]
      .filter(isTerminal)
      .sort((a, b) => a.startedAt - b.startedAt);
    while (jobs.size > MAX_RETAINED_JOBS && completed.length > 0) {
      removeJob(completed.shift()!);
    }
  }

  function finalizeJob(job: Job, code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (job.finalized) return;
    job.finalized = true;
    if (job.forceKillTimer) clearTimeout(job.forceKillTimer);

    flushDecoders(job);
    job.exitCode = code;
    job.signalCode = signal;
    if (error) {
      job.status = "failed";
      job.error = error.message;
    } else if (job.status === "stopping") {
      job.status = job.stopReason === "abort" ? "failed" : "stopped";
    } else if (signal || code === null) {
      job.status = "failed";
    } else {
      job.status = "exited";
    }
    job.outputStream.end();
    job.finish();
    job.retentionTimer = setTimeout(() => removeJob(job), COMPLETED_JOB_RETENTION_MS);
    job.retentionTimer.unref();
    pruneJobs();
  }

  function startJob(command: string, cwd: string, env: NodeJS.ProcessEnv): Job {
    const id = `cmd-${nextJobId++}`;
    const outputDir = mkdtempSync(join(tmpdir(), `pi-bash-jobs-${process.pid}-${id}-`));
    const outputPath = join(outputDir, "output.log");
    const outputStream = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
    const shellConfig = getShellConfig();
    const commandFromStdin = shellConfig.commandTransport === "stdin";
    const child = spawn(
      shellConfig.shell,
      commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
      {
        cwd,
        detached: process.platform !== "win32",
        env,
        stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    if (commandFromStdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(command);
    }

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const job: Job = {
      id,
      command,
      cwd,
      child,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      signalCode: null,
      outputPath,
      outputStream,
      pending: "",
      droppedBytes: 0,
      droppedLines: 0,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      completion,
      finish: resolveCompletion,
      finalized: false,
    };
    jobs.set(id, job);

    outputStream.on("drain", () => resumeOutput(job));
    outputStream.on("error", (error) => {
      job.logError = error.message;
      resumeOutput(job);
    });
    child.stdout?.on("data", (data: Buffer) => appendOutput(job, data, job.stdoutDecoder));
    child.stderr?.on("data", (data: Buffer) => appendOutput(job, data, job.stderrDecoder));
    child.once("error", (error) => finalizeJob(job, null, null, error));
    child.once("close", (code, signal) => finalizeJob(job, code, signal));

    pruneJobs();
    return job;
  }

  pi.registerTool({
    name: "bash",
    label: "bash (non-blocking)",
    description:
      "Execute a bash command. A running command is handed off after 15 seconds and can be controlled with bash_job. Aborting the tool call (user interrupt) NEVER terminates the process: it detaches and keeps running in the background under its job ID; use bash_job to follow it or bash_job stop to terminate it. Reports keep the last 2000 lines or 50KB, and full output is saved to a private temporary log.",
    promptSnippet: "Execute commands; hand off long-running commands after 15 seconds",
    promptGuidelines: [
      "When bash returns a running job ID, choose a useful bash_job wait duration based on the command's expected progress; reassess after each wait",
      "A user abort of a bash call never kills the underlying process; it keeps running under its job ID, so follow up with bash_job status/wait instead of assuming it died",
    ],
    parameters: bashSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.PI_SESSION_ID;
      delete env.PI_SESSION_FILE;
      delete env.PI_PROVIDER;
      delete env.PI_MODEL;
      delete env.PI_REASONING_LEVEL;
      env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) env.PI_SESSION_FILE = sessionFile;
      if (ctx.model) {
        env.PI_PROVIDER = ctx.model.provider;
        env.PI_MODEL = ctx.model.id;
      }
      if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;

      const job = startJob(params.command, ctx.cwd, env);
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let acceptingUpdates = true;
      const emitUpdate = () => {
        updateTimer = undefined;
        if (!acceptingUpdates || !updateDirty || !onUpdate) return;
        updateDirty = false;
        const text = readPending(job, false);
        onUpdate({
          content: text ? [{ type: "text", text }] : [],
          details: { fullOutputPath: job.outputPath },
        });
      };
      const scheduleUpdate = () => {
        if (!onUpdate || !acceptingUpdates) return;
        updateDirty = true;
        updateTimer ??= setTimeout(emitUpdate, UPDATE_THROTTLE_MS);
      };
      childOutputListeners(job, scheduleUpdate);

      const initialWaitMs = HANDOFF_AFTER_SECONDS * 1_000;
      const abort = KILL_ON_ABORT ? () => requestStop(job, "abort") : undefined;
      if (abort) signal?.addEventListener("abort", abort, { once: true });
      await waitForJob(job, initialWaitMs, signal);
      if (abort) signal?.removeEventListener("abort", abort);
      acceptingUpdates = false;
      if (updateTimer) clearTimeout(updateTimer);

      if (signal?.aborted) {
        if (KILL_ON_ABORT) throw new Error(`Command aborted (job ${job.id}); termination was requested.`);
        if (isTerminal(job)) {
          const doneOutput = readPending(job, true);
          throw new Error(
            [
              doneOutput,
              `Tool call aborted by the user; the process had already finished on its own. ${finalStatus(job)}`,
              `Full output: ${job.outputPath}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
        }
        throw new Error(
          [
            "Tool call aborted by the user, but the process was NOT terminated (detach-on-abort).",
            `Job ID: ${job.id} — still running in the background. Use bash_job status/wait to follow it, or bash_job stop to terminate it.`,
            `Full output: ${job.outputPath}`,
          ].join("\n"),
        );
      }
      const output = readPending(job, true);
      if (!isTerminal(job)) {
        const text = [
          output,
          `Command is still running and was not paused or terminated. Job ID: ${job.id}.`,
          "Use bash_job wait with a duration chosen from expected progress, status to inspect immediately, or stop to terminate it.",
          `Full output: ${job.outputPath}`,
          logWarning(job),
        ]
          .filter(Boolean)
          .join("\n\n");
        return { content: [{ type: "text", text }], details: { fullOutputPath: job.outputPath } };
      }

      const text = [output || "(no output)", finalStatus(job), logWarning(job)].filter(Boolean).join("\n\n");
      if (terminalFailure(job)) throw new Error(text);
      return { content: [{ type: "text", text }], details: { fullOutputPath: job.outputPath } };
    },
  });

  function childOutputListeners(job: Job, onOutput: () => void): void {
    job.child.stdout?.on("data", onOutput);
    job.child.stderr?.on("data", onOutput);
  }

  pi.registerTool({
    name: "bash_job",
    label: "Bash Job",
    description:
      "Control a command handed off by bash. For `wait`, choose `seconds` based on expected progress; waiting returns sooner on completion. `status` inspects immediately and `stop` terminates the process tree.",
    promptSnippet: "Wait for, inspect, or stop a handed-off bash command",
    promptGuidelines: [
      "Use bash_job wait for a running job and choose seconds based on expected progress; if it remains active, reassess before waiting again",
    ],
    parameters: jobSchema,
    async execute(_toolCallId, params, signal) {
      const job = jobs.get(params.jobId);
      if (!job) throw new Error(`Unknown or expired bash job: ${params.jobId}`);

      if (params.action === "stop") {
        requestStop(job, "user");
        await waitForJob(job, STOP_WAIT_MS, signal);
      } else if (params.action === "wait") {
        if (params.seconds === undefined) throw new Error("seconds is required when action=wait");
        await waitForJob(job, params.seconds * 1_000, signal);
      }
      if (signal?.aborted) {
        throw new Error(`bash_job ${params.action} was cancelled; job ${job.id} was not stopped automatically.`);
      }

      const output = readPending(job, true);
      const status = finalStatus(job);
      const guidance = !isTerminal(job)
        ? "The process is still active. Choose whether and how long to wait again, inspect later, or stop it."
        : `Full output: ${job.outputPath}`;
      const text = [output || "(no new output)", status, guidance, logWarning(job)].filter(Boolean).join("\n\n");
      if (terminalFailure(job)) throw new Error(text);
      return {
        content: [{ type: "text", text }],
        details: {
          jobId: job.id,
          status: job.status,
          exitCode: job.exitCode,
          signalCode: job.signalCode,
          fullOutputPath: job.outputPath,
        },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    const active = [...jobs.values()].filter((job) => !isTerminal(job));
    for (const job of active) requestStop(job, "shutdown");
    await Promise.all(active.map((job) => waitForJob(job, STOP_WAIT_MS)));
    for (const job of active) {
      if (!isTerminal(job)) sendSignal(job, "SIGKILL");
    }
    await Promise.all(active.map((job) => waitForJob(job, 1_000)));
    for (const job of [...jobs.values()]) {
      if (isTerminal(job)) removeJob(job);
    }
  });
}
