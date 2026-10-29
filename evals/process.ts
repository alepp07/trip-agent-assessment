import { spawnSync, type SpawnSyncReturns } from "child_process";

/** Launch npm's JS entrypoint through Node, avoiding Windows npm.cmd shells.
 * npm supplies npm_execpath when the user runs `npm run evals`.
 * Arguments stay an array, including goals and Windows paths containing spaces.
 */
export function agentCommand(flags: string[], env: NodeJS.ProcessEnv = process.env, node = process.execPath): { file: string; args: string[] } {
  const npmCli = env.npm_execpath;
  if (!npmCli) throw new Error("Run the evaluations with npm run evals so npm supplies its CLI entrypoint.");
  return { file: node, args: [npmCli, "run", "agent", "--", ...flags] };
}

export function launchAgent(flags: string[], cwd: string, timeout: number): SpawnSyncReturns<string> {
  const command = agentCommand(flags);
  return spawnSync(command.file, command.args, {
    cwd, timeout, encoding: "utf8", shell: false, windowsHide: true,
  });
}

export function processFailure(result: Pick<SpawnSyncReturns<string>, "error" | "status" | "signal" | "stderr" | "stdout">, timeout: number): string {
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") return `agent timed out after ${timeout}ms`;
  if (error) return `agent could not start (${error.code ?? error.name})`;
  const detail = (result.stderr || result.stdout || "").trim().slice(-800);
  if (result.signal) return `agent stopped by ${result.signal}${detail ? `: ${detail}` : ""}`;
  return `agent exited ${result.status ?? "without an exit status"}${detail ? `: ${detail}` : ""}`;
}
