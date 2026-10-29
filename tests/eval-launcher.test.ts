import { describe, expect, it } from "vitest";
import { agentCommand, launchAgent, processFailure } from "../evals/process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

describe("cross-platform public evaluation launcher", () => {
  it("uses Node plus npm-cli.js with Windows paths and spaces as distinct arguments", () => {
    const goal = "Find a flight for Maria Silva; do not interpret this as shell code.";
    const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const node = "C:\\Program Files\\nodejs\\node.exe";
    expect(agentCommand(["--goal", goal, "--output", "C:\\New folder\\result.json"], { npm_execpath: npmCli }, node)).toEqual({
      file: node, args: [npmCli, "run", "agent", "--", "--goal", goal, "--output", "C:\\New folder\\result.json"],
    });
  });
  it("identifies startup failure instead of falsely reporting a timeout", () => {
    const result = { error: Object.assign(new Error("not found"), { code: "ENOENT" }), status: null, signal: null, stderr: "", stdout: "" };
    expect(processFailure(result, 120000)).toContain("could not start (ENOENT)");
    expect(processFailure(result, 120000)).not.toContain("timed out");
  });
  it("identifies an actual timeout and preserves nonzero-exit diagnostics", () => {
    expect(processFailure({ error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM", stderr: "", stdout: "" }, 120000)).toContain("timed out after 120000ms");
    expect(processFailure({ error: undefined, status: 1, signal: null, stderr: "Missing package", stdout: "" }, 120000)).toContain("exited 1: Missing package");
  });
  it("launches the real npm agent command inside a project path containing spaces", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trip launch spaces "));
    const goal = "A goal with spaces & punctuation; keep as one argument.";
    try {
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { agent: "node agent.cjs" } }));
      await fs.writeFile(path.join(dir, "agent.cjs"), "console.log('ARGS:' + JSON.stringify(process.argv.slice(2)))");
      const result = launchAgent(["--goal", goal], dir, 15000);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      const line = result.stdout.split(/\r?\n/).find(s => s.startsWith("ARGS:"))!;
      expect(JSON.parse(line.slice(5))).toEqual(["--goal", goal]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
